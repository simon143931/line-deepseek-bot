// index.js
// LINE + Gemini 升級版獵影教練 Bot
// - 文字 + 圖片 都丟給 Gemini（不用 Cloud Vision API）
// - 自動盤勢判斷（盤整 / 趨勢 / 無法判斷）
// - 寫入 trades.json 做之後 Dashboard / 回測用
// - 提供 /api/trades & /dashboard 簡易儀表板

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs/promises";
import { systemPrompt } from "./prompt.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------- Env & 小工具 ----------------

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";

if (!LINE_CHANNEL_ACCESS_TOKEN) console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
if (!LINE_CHANNEL_SECRET) console.warn("⚠️ LINE_CHANNEL_SECRET 未設定（將略過簽名驗證）");
if (!GOOGLE_AI_API_KEY) console.warn("⚠️ GOOGLE_AI_API_KEY 未設定");
console.log("✅ Using model:", GOOGLE_AI_MODEL);

// 讓 Render / 監控用
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

function redactedKey(k) {
  if (!k) return "(empty)";
  return k.slice(0, 4) + "..." + k.slice(-4);
}
console.log("Gemini key =", redactedKey(GOOGLE_AI_API_KEY));

// ---------------- LINE 簽名驗證 ----------------

function verifyLineSignature(req, res, next) {
  if (!LINE_CHANNEL_SECRET) return next(); // 沒設定就先略過，不擋住 webhook

  try {
    const signature = req.get("x-line-signature") || "";
    const body = JSON.stringify(req.body);
    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(body)
      .digest("base64");

    if (hash !== signature) {
      console.warn("❌ Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }
    next();
  } catch (e) {
    console.error("verifyLineSignature error:", e);
    next();
  }
}

// ---------------- trades.json 儲存層 ----------------

const TRADES_FILE = "./trades.json";

async function loadTrades() {
  try {
    const txt = await fs.readFile(TRADES_FILE, "utf-8");
    const data = JSON.parse(txt);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    console.error("loadTrades error:", e);
    return [];
  }
}

async function saveTrades(trades) {
  try {
    await fs.writeFile(TRADES_FILE, JSON.stringify(trades, null, 2), "utf-8");
  } catch (e) {
    console.error("saveTrades error:", e);
  }
}

// ---------------- 通用 Gemini caller (文字) ----------------

// 最牛逼錯誤防護版 askGoogleAI：多種 body shape + retry + 404/400 判斷
async function askGoogleAI(userText, sysPrompt = systemPrompt) {
  if (!GOOGLE_AI_API_KEY) {
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統設定錯誤：AI 金鑰未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const baseUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";
  const urlWithKey = baseUrl + "?key=" + encodeURIComponent(GOOGLE_AI_API_KEY);

  const headers = { "Content-Type": "application/json" };

  const mainPrompt = (sysPrompt || "") + "\n\n" + (userText || "");

  const bodyContents = {
    contents: [
      {
        role: "user",
        parts: [{ text: mainPrompt }],
      },
    ],
  };

  const altBodies = [
    bodyContents,
    {
      contents: [
        { role: "system", parts: [{ text: sysPrompt || "" }] },
        { role: "user", parts: [{ text: userText || "" }] },
      ],
    },
    { input: mainPrompt },
  ];

  const maxRetry = 2;

  for (let bodyIdx = 0; bodyIdx < altBodies.length; bodyIdx++) {
    let body = altBodies[bodyIdx];
    let attempt = 0;
    let shrinkingText = userText || "";

    while (attempt <= maxRetry) {
      try {
        const res = await axios.post(urlWithKey, body, {
          headers,
          timeout: 20000,
        });

        const data = res.data || {};

        const text =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.candidates?.[0]?.content?.text ||
          data?.text ||
          null;

        if (text) return String(text);

        console.warn(
          "Google AI success but no text. keys=",
          Object.keys(data || {})
        );
        return JSON.stringify(data).slice(0, 1500);
      } catch (err) {
        attempt++;
        const status = err?.response?.status;
        const respData = err?.response?.data;

        if (status === 400 && shrinkingText.length > 500) {
          // body 太大，剪短 userText 後重試
          shrinkingText = shrinkingText.slice(0, 400);
          if (body.contents && body.contents[0]?.parts?.[0]) {
            body.contents[0].parts[0].text =
              (sysPrompt || "") + "\n\n" + shrinkingText;
          }
          continue;
        }

        if (status === 404) {
          console.error(
            `Google API 404 Not Found for model=${model}. data=`,
            respData || err.message
          );
        }

        if (attempt > maxRetry) {
          console.error(
            `askGoogleAI failed (bodyIdx=${bodyIdx}) after ${attempt} attempts. status=${status}, err=${err.message}`
          );
          if (respData) {
            console.error(
              "Response data snippet:",
              JSON.stringify(respData).slice(0, 1000)
            );
          }
          break;
        }

        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  return "⚠️ AI 目前無回應（多次嘗試失敗）。請稍後再試或檢查 GOOGLE_AI_API_KEY / GOOGLE_AI_MODEL 設定。";
}

// ---------------- Gemini 圖片分析（inline_data） ----------------

async function analyzeImageWithGeminiBase64(base64Image) {
  if (!GOOGLE_AI_API_KEY) {
    return { error: "GOOGLE_AI_API_KEY 未設定" };
  }

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(GOOGLE_AI_API_KEY);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "這是一張 K 線 / 技術指標截圖。\n" +
              "請用條列方式回答：\n" +
              "1. 現在盤勢偏盤整還是偏趨勢？\n" +
              "2. OBV 與 MA、布林帶的大致關係（用描述即可）。\n" +
              "3. 是否有出現 十字星 / 實體吞沒 / 影線吞沒（有就寫出來）。\n" +
              "最後用一句話總結『獵影策略是否適用（適用 / 不適用 / 無法判斷）』。",
          },
          {
            inline_data: {
              mime_type: "image/png",
              data: base64Image,
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    const parts =
      res.data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => p.text || "")
      .join("\n")
      .trim();

    return { summary: text || "(模型沒有回應文字)" };
  } catch (err) {
    console.error(
      "Gemini Vision error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return { error: err.response?.data || err.message };
  }
}

// ---------------- 盤勢分類 helper ----------------

async function classifyRegime(contextText) {
  if (!GOOGLE_AI_API_KEY) {
    return {
      regime: "unknown",
      strategyAllowed: false,
      reason: "GOOGLE_AI_API_KEY 未設定",
    };
  }

  const classifyPrompt =
    '你是一位專門判斷「獵影策略是否適用」的盤勢分類助手，只回答 JSON。\n\n' +
    "請依照以下規則判斷：\n" +
    '- 如果描述中顯示 OBV 在 MA 上下來回、價格在區間裡震盪、沒有明顯單邊方向，判定為 "range"（盤整，可用策略）。\n' +
    '- 如果描述中有明顯單邊上漲或下跌、突破走趨勢，判定為 "trend"（趨勢，不可用策略）。\n' +
    '- 其他無法判斷時，判定為 "unknown"。\n\n' +
    "請輸出純 JSON，不要加任何解釋文字，例如：\n" +
    '{"regime":"range","strategyAllowed":true,"reason":"OBV 在 MA 兩側來回、價格在區間震盪"}\n\n' +
    "現在的情境描述如下：\n" +
    contextText;

  const raw = await askGoogleAI(classifyPrompt, ""); // 不疊加獵影 systemPrompt

  try {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) throw new Error("no json");
    const jsonStr = raw.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);

    let regime = parsed.regime || "unknown";
    if (!["range", "trend", "unknown"].includes(regime)) {
      regime = "unknown";
    }

    const strategyAllowed =
      regime === "range" && parsed.strategyAllowed !== false;
    const reason = parsed.reason || "";

    return { regime, strategyAllowed, reason };
  } catch (e) {
    console.error("classifyRegime parse error:", e, "raw:", raw);
    return {
      regime: "unknown",
      strategyAllowed: false,
      reason: "parse error",
    };
  }
}

// ---------------- LINE 回覆 helper ----------------

async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    await axios.post(
      url,
      { replyToken, messages: [{ type: "text", text }] },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error(
      "replyToLine error:",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// ---------------- Webhook 主體 ----------------

app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    const replyToken = event.replyToken;
    const userId = event.source?.userId || "unknown";

    if (event.type !== "message") continue;

    try {
      const message = event.message;

      // ---------- 文字訊息 ----------
      if (message.type === "text") {
        const userText = message.text || "";

        const answer = await askGoogleAI(userText, systemPrompt);

        const contextForRegime =
          "使用者訊息：" +
          userText +
          "\n\nAI 回應：" +
          answer.slice(0, 800);

        const regimeInfo = await classifyRegime(contextForRegime);

        let prefix = "";
        if (regimeInfo.regime === "range") {
          prefix =
            "📊 盤勢判定：偏盤整，獵影策略【可以使用】（仍然要嚴守停損）。\n";
        } else if (regimeInfo.regime === "trend") {
          prefix =
            "📊 盤勢判定：偏趨勢，獵影策略【不建議使用】，以觀望為主。\n";
        } else {
          prefix =
            "📊 盤勢判定：無法明確分辨盤整 / 趨勢，請保守使用獵影策略。\n";
        }

        const replyText = (prefix + "\n" + answer).slice(0, 2000);
        await replyToLine(replyToken, replyText);

        const trades = await loadTrades();
        trades.push({
          id:
            Date.now().toString() +
            "_" +
            Math.random().toString(36).slice(2, 8),
          time: new Date().toISOString(),
          source: "line",
          userId,
          kind: "text",
          userText,
          aiAnswer: answer,
          regime: regimeInfo.regime,
          strategyAllowed: regimeInfo.strategyAllowed,
          regimeReason: regimeInfo.reason,
        });
        await saveTrades(trades);

        // ---------- 圖片訊息 ----------
      } else if (message.type === "image") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        let imgBase64;
        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: {
              Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            timeout: 15000,
          });
          imgBase64 = Buffer.from(imgRes.data).toString("base64");
        } catch (err) {
          console.error(
            "download image error:",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
          continue;
        }

        const vision = await analyzeImageWithGeminiBase64(imgBase64);
        if (vision.error) {
          await replyToLine(
            replyToken,
            "AI 無法解析圖片，請稍後再試或改用文字描述。"
          );
          continue;
        }

        const imgSummary = vision.summary || "(無法取得圖片摘要)";

        const regimeInfo = await classifyRegime(
          "圖片盤勢摘要：" + imgSummary.slice(0, 800)
        );

        const qaPrompt =
          "以下是使用者傳來的一張 K 線 / 指標截圖的 AI 文字摘要：\n" +
          imgSummary +
          "\n\n請你完全依照《獵影策略》的規則，幫使用者跑完決策流程（盤整判斷、三種型態、進場點、停損、停利、風險提醒）。";

        const answer = await askGoogleAI(qaPrompt, systemPrompt);

        let prefix = "";
        if (regimeInfo.regime === "range") {
          prefix =
            "📊 盤勢判定：偏盤整，獵影策略【可以使用】（記得固定 1R 風險）。\n";
        } else if (regimeInfo.regime === "trend") {
          prefix =
            "📊 盤勢判定：偏趨勢，獵影策略【不建議使用】，先觀望。\n";
        } else {
          prefix =
            "📊 盤勢判定：無法明確分辨盤整 / 趨勢，請保守使用獵影策略。\n";
        }

        const replyText =
          (
            "📷 圖片分析摘要：\n" +
            imgSummary.slice(0, 800) +
            "\n\n" +
            prefix +
            "\n" +
            answer
          ).slice(0, 2000);

        await replyToLine(replyToken, replyText);

        const trades = await loadTrades();
        trades.push({
          id:
            Date.now().toString() +
            "_" +
            Math.random().toString(36).slice(2, 8),
          time: new Date().toISOString(),
          source: "line",
          userId,
          kind: "image",
          imageSummary: imgSummary,
          aiAnswer: answer,
          regime: regimeInfo.regime,
          strategyAllowed: regimeInfo.strategyAllowed,
          regimeReason: regimeInfo.reason,
        });
        await saveTrades(trades);
      } else {
        await replyToLine(
          replyToken,
          "目前只支援文字與圖片訊息，其他類型暫不支援喔。"
        );
      }
    } catch (e) {
      console.error(
        "Error processing event:",
        e.response?.data || e.message || e
      );
    }
  }

  res.status(200).send("OK");
});

// ---------------- API: 讓之後 Dashboard 用 ----------------

app.get("/api/trades", async (req, res) => {
  const trades = await loadTrades();
  res.json({ trades });
});

// ---------------- 超簡單 Dashboard ----------------

const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>獵影策略 Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 16px; background:#0b1020; color:#f5f5f5; }
    h1 { margin-bottom: 8px; }
    .cards { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
    .card { background:#151a2c; border-radius:12px; padding:12px 16px; min-width:160px; box-shadow:0 4px 16px rgba(0,0,0,0.4); }
    .label { font-size:12px; opacity:0.7; }
    .value { font-size:20px; font-weight:bold; margin-top:4px; }
    canvas { background:#0b1020; border-radius:12px; padding:8px; }
    .chart-row { display:flex; flex-wrap:wrap; gap:20px; }
    .chart-box { flex:1 1 280px; }
    a { color:#4fc3f7; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <h1>獵影策略 Dashboard</h1>
  <div class="label">資料來源：trades.json（來自 LINE Bot 實際互動）</div>

  <div class="cards">
    <div class="card">
      <div class="label">總紀錄數</div>
      <div class="value" id="totalTrades">-</div>
    </div>
    <div class="card">
      <div class="label">盤整次數 (range)</div>
      <div class="value" id="rangeCount">-</div>
    </div>
    <div class="card">
      <div class="label">趨勢次數 (trend)</div>
      <div class="value" id="trendCount">-</div>
    </div>
    <div class="card">
      <div class="label">策略可用比例</div>
      <div class="value" id="allowedRatio">-</div>
    </div>
  </div>

  <div class="chart-row">
    <div class="chart-box">
      <canvas id="regimeChart" height="240"></canvas>
    </div>
    <div class="chart-box">
      <canvas id="timelineChart" height="240"></canvas>
    </div>
  </div>

  <script>
    async function loadTrades() {
      const res = await fetch('/api/trades');
      const json = await res.json();
      return json.trades || [];
    }

    function groupByRegime(trades) {
      const counts = { range:0, trend:0, unknown:0 };
      trades.forEach(t => {
        const r = t.regime || 'unknown';
        if (counts[r] === undefined) counts[r] = 0;
        counts[r] += 1;
      });
      return counts;
    }

    function buildTimeline(trades) {
      const byDay = {};
      trades.forEach(t => {
        const d = (t.time || '').slice(0,10);
        if (!d) return;
        if (!byDay[d]) byDay[d] = { total:0, range:0 };
        byDay[d].total += 1;
        if (t.regime === 'range') byDay[d].range += 1;
      });
      const days = Object.keys(byDay).sort();
      return {
        labels: days,
        total: days.map(d => byDay[d].total),
        range: days.map(d => byDay[d].range)
      };
    }

    function makeRegimeChart(ctx, counts) {
      new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['range(盤整)','trend(趨勢)','unknown'],
          datasets: [{
            data: [counts.range, counts.trend, counts.unknown]
          }]
        },
        options: {
          plugins: {
            legend: { labels: { color:'#f5f5f5' } }
          }
        }
      });
    }

    function makeTimelineChart(ctx, timeline) {
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: timeline.labels,
          datasets: [
            { label:'總紀錄數', data: timeline.total, borderWidth:2 },
            { label:'盤整次數(range)', data: timeline.range, borderWidth:2 }
          ]
        },
        options: {
          scales: {
            x: { ticks:{ color:'#f5f5f5' } },
            y: { ticks:{ color:'#f5f5f5' } }
          },
          plugins: {
            legend: { labels: { color:'#f5f5f5' } }
          }
        }
      });
    }

    (async function init() {
      const trades = await loadTrades();

      const total = trades.length;
      const counts = groupByRegime(trades);
      const allowedCount = trades.filter(t => t.strategyAllowed).length;
      const allowedRatio = total ? (allowedCount * 100 / total).toFixed(1) + '%' : '-';

      document.getElementById('totalTrades').textContent = total;
      document.getElementById('rangeCount').textContent = counts.range || 0;
      document.getElementById('trendCount').textContent = counts.trend || 0;
      document.getElementById('allowedRatio').textContent = allowedRatio;

      const timeline = buildTimeline(trades);

      const regimeCtx = document.getElementById('regimeChart').getContext('2d');
      makeRegimeChart(regimeCtx, counts);

      const tlCtx = document.getElementById('timelineChart').getContext('2d');
      makeTimelineChart(tlCtx, timeline);
    })();
  </script>
</body>
</html>`;

app.get("/dashboard", (req, res) => {
  res.type("html").send(dashboardHtml);
});

// ---------------- 啟動伺服器 ----------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("LINE Bot webhook listening on port " + PORT);
});
