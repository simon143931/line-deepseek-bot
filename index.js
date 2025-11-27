// index.js - 獵影策略 LINE Bot（完整版 + 文字紀錄 + 篩選 Dashboard）

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ------- 健康檢查 --------
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// ------- ENV 設定 --------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";

console.log("=== Bot 啟動設定 ===");
console.log("LINE_CHANNEL_ACCESS_TOKEN:", LINE_CHANNEL_ACCESS_TOKEN ? "set" : "MISSING");
console.log("LINE_CHANNEL_SECRET:", LINE_CHANNEL_SECRET ? "set" : "MISSING");
console.log("GOOGLE_AI_MODEL:", GOOGLE_AI_MODEL);
console.log("GOOGLE_AI_API_KEY:", GOOGLE_AI_API_KEY ? GOOGLE_AI_API_KEY.slice(0, 4) + "..." + GOOGLE_AI_API_KEY.slice(-4) : "MISSING");
console.log("===================");

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
}
if (!LINE_CHANNEL_SECRET) {
  console.warn("⚠️ LINE_CHANNEL_SECRET 未設定，webhook 驗簽不會生效");
}
if (!GOOGLE_AI_API_KEY) {
  console.warn("⚠️ GOOGLE_AI_API_KEY 未設定，Gemini 相關功能無法使用");
}

// ------- 系統 Prompt（獵影教練）--------
const systemPrompt = `你是一位專門教學「獵影策略」的交易教練 AGENT。

【你的唯一參考聖經】
- 以使用者提供的《獵影策略》PDF 為最高優先依據。
- 如果外部資訊與 PDF 內容衝突，一律以 PDF 為主。
- 你的任務不是發明新策略，而是「忠實解釋、拆解與提醒」這套策略。

【策略核心觀念（由你隨時幫使用者複習）】
1. 此策略只適用於「盤整行情」：
- 利用 OBV 在 MA 上下來回碰觸布林帶的型態，判斷是否為盤整。
- 當 OBV 持續在 MA 之下時，屬於策略禁用時期，要提醒使用者不要硬做。

2. 進場必要條件：
- OBV 必須先「突破布林帶」，下一根 K 棒收盤「收回布林帶內」。
- 然後 K 棒要符合三種形態之一：
(1) 十字星
(2) 實體吞沒
(3) 影線吞沒
- 一律要等 K 棒「收盤後」再判斷，請你每次都提醒使用者這一點。

3. 三種型態具體定義：
- 十字星：
  - 上下影線明顯，實體部分小於等於 0.05%。
  - 進場方式：市價進場，停損依照 ATR。
- 實體吞沒：
  - 當前 K 棒的「實體」完全吞沒前一根 K 棒。
  - 進場方式：用斐波那契找出實體 0.5 的位置掛單，停損依 ATR。
- 影線吞沒：
  - 當前 K 棒的「影線」超出前一根 K 棒的影線。
  - 進場方式：在 SNR 水平掛單進場，停損依 ATR。

4. 止盈止損與風險控管：
- 建議盈虧比 1R ~ 1.5R。
- 單筆虧損金額要固定，避免小贏大賠。
- 舉例：如果倉位是 50%，實盤 0.45% 的波動配 100 倍槓桿，只是約 45% 獲利，不能太貪。
- 如果連續三單止損，視為盤整結束或行情轉變，應提醒使用者「先退出觀望」。

【你回答問題的風格與格式】
1. 使用「繁體中文」，語氣像一位冷靜、實戰派的交易教練，口語但不廢話。

2. 每次回答問題時，請盡量依照以下結構：
A. 先用一兩句，判斷「這個情境是否適用獵影策略」。
B. 如果適用，逐步拆解：
- 第 1 步：先看 OBV 與布林帶狀況
- 第 2 步：檢查三種 K 棒型態是否成立
- 第 3 步：說明進場方式（市價 / 掛單在哪裡）
- 第 4 步：如何依 ATR 設停損
- 第 5 步：如何設 1R ~ 1.5R 停利
C. 如果不適用，直接說明為何不適用，並提醒使用者最好空手觀望。

3. 如果使用者只問「能不能進場？」或給你一句不完整的描述，你要：
(1) 先主動幫使用者檢查以下四件關鍵事：
- 現在是否為盤整行情？（依 OBV + 布林帶規則）
- 有沒有符合三種 K 棒進場型態之一？（十字星、實體吞沒、影線吞沒）
- ATR 的距離有沒有足夠風險收益比？（至少 1R 以上）
- 有沒有連虧三單、應該暫停交易？

(2) 如果使用者資訊不夠，請主動告訴他：
- 「你還缺少哪幾個資訊，才有辦法正確判斷」
- 用最簡單、易懂的形式引導他補充，例如：
  - 「你還沒告訴我 OBV 現在相對 MA 的位置哦，我需要知道這點才能判斷是不是盤整。」
  - 「你可以只告訴我：這根 K 棒是不是長影線 / 吞沒前一根？」

(3) 當所有條件齊備後，你要主動完整輸出以下決策報告：
A. 「此盤勢是否符合盤整？」（是／否 + 判斷依據）
B. 「是否符合三種進場型態之一？」（是哪一種＋理由）
C. 「建議進場價格、停損位置（用 ATR 估計）、1R、1.5R 停利點」
D. 「風險評估與提醒」（例：如果 ATR 太小／已虧三單／趨勢走強，應建議觀望）

(4) 如果所有條件不成立，你要直接講：
- 「這不是獵影策略該進場的位置，建議觀望。」並幫他講清楚原因。

⚠️ 記住：使用者不需要懂策略、不需要學習。不管他說什麼，你都要幫他把獵影策略邏輯跑完，並主動提醒缺失與風險。你是他的策略保鑣。

4. 如果使用者問的是「觀念問題」（例：什麼是十字星？為什麼要等收盤？）：
- 你要用生活化比喻、分點解釋，讓「交易小白」也能看懂。
- 可以舉《獵影策略》中的段落做解釋，但不要長篇照抄，改用自己的話。

5. 用風險警示保護使用者：
- 你不能保證獲利，只能說「根據這個策略，理論上該怎麼做」。
- 當使用者太貪婪或想 All in，你要主動提醒風險與「連虧三單就停止」的規則。
- 你只提供教育性說明，不能給「保證賺錢」或「一定會翻倍」的承諾。

【你要主動做的幾件事】
- 每當使用者問你一個進場點，你要順便幫他檢查：
  1. 現在是不是盤整行情？
  2. 有沒有符合 OBV + 布林必要條件？
  3. 有沒有符合三種型態其中一種？
  4. 有沒有合理的停損位置與 1~1.5R 停利位置？

- 如果使用者的描述不足以判斷，你要告訴他：
  - 你還缺「哪幾個關鍵資訊」（例如：OBV 相對 MA 的位置、影線是否超過前一根、ATR 數值等）。
  - 再請他補充數據或更清楚的描述，而不是亂猜。

請你牢記以上所有規則，之後所有回答一律遵守。`;

// ------- trades.json 讀寫 --------
const TRADES_PATH = path.join(__dirname, "trades.json");

async function loadTrades() {
  try {
    const raw = await fs.readFile(TRADES_PATH, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return [];
  } catch (e) {
    // 如果檔案不存在，回傳空陣列
    if (e.code === "ENOENT") return [];
    console.error("loadTrades error:", e.message);
    return [];
  }
}

async function saveTrades(trades) {
  try {
    await fs.writeFile(TRADES_PATH, JSON.stringify(trades, null, 2), "utf8");
  } catch (e) {
    console.error("saveTrades error:", e.message);
  }
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

// ------- 解析文字裡的 symbol + timeframe --------
// 支援格式：
// "BTCUSDT 15m xxx", "BTC 4h 這裡能進場嗎", "ETH/USDT 1h：能空嗎？"
function parseMetaFromText(originalText = "") {
  let text = originalText.trim();

  // 先抓「幣種 + 週期」在前面的情況
  const re =
    /^([A-Za-z]{3,15}(?:USDT)?(?:\/USDT)?)\s+(\d+(?:m|M|h|H|d|D))\s*[:：\-]?\s*(.*)$/;
  const m = text.match(re);

  if (m) {
    let symbol = m[1].toUpperCase().replace("/USDT", "USDT");
    let timeframe = m[2].toLowerCase();
    const cleanText = (m[3] || "").trim();
    return { symbol, timeframe, cleanText: cleanText || originalText };
  }

  // 抓不到就原樣回傳
  return {
    symbol: null,
    timeframe: null,
    cleanText: originalText,
  };
}

// ------- 呼叫 Gemini（文字）--------
async function askGeminiText(userText) {
  if (!GOOGLE_AI_API_KEY) {
    return "⚠️ 系統錯誤：尚未設定 GOOGLE_AI_API_KEY，請聯絡管理員。";
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GOOGLE_AI_MODEL
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              systemPrompt +
              "\n\n---\n下面是使用者的提問，請依獵影策略規則回答：\n\n" +
              (userText || ""),
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
    });

    const data = res.data || {};
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      data.candidates?.[0]?.content?.text ||
      data.text ||
      "（模型無回應內容）";

    return text;
  } catch (err) {
    console.error(
      "askGeminiText error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return "⚠️ AI 目前沒有回應，請稍後再試。";
  }
}

// ------- 呼叫 Gemini（圖片）--------
// 直接用 Gemini Vision，不用 Cloud Vision API
async function analyzeImageWithGemini(base64Image) {
  if (!GOOGLE_AI_API_KEY) {
    return {
      error: "GOOGLE_AI_API_KEY 未設定",
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GOOGLE_AI_MODEL
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const visionPrompt = `
你會收到一張 K 線圖 (含 OBV + 布林帶)，請你幫我做 **獵影策略專用分析**。

請你務必輸出「純 JSON」，不要加註解、不要加多餘文字，格式如下（key 名稱固定）：

{
  "regime": "consolidation | trend | unknown",
  "strategyAllowed": true or false,
  "direction": "long | short | none | unknown",
  "r": null,
  "entry": null,
  "stop": null,
  "tp1R": null,
  "tp1_5R": null,
  "reason": "用中文簡短說明為什麼這樣判斷（最多 100 字）"
}

規則說明（給你參考，不要重複輸出）：
- 如果 OBV 持續在 MA 之下、明顯單邊趨勢，regime = "trend"，strategyAllowed = false。
- 如果 OBV 在 MA 上下震盪且布林帶有來回碰觸，regime 偏向 "consolidation"，strategyAllowed 通常為 true，但如果訊號很醜可以給 false。
- direction 在沒有明確訊號時請回傳 "unknown" 或 "none"。
- r / entry / stop / tp1R / tp1_5R 在你無法判斷時，請全部給 null。
`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: visionPrompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
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

    const data = res.data || {};
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      data.text ||
      null;

    if (!text) {
      return { error: "模型沒有回應文字" };
    }

    // 嘗試從純文字中抓 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { error: "無法從回應中找到 JSON", raw: text };
    }

    try {
      const obj = JSON.parse(jsonMatch[0]);
      return { ok: true, data: obj, raw: text };
    } catch (e) {
      console.error("parse vision JSON error:", e.message);
      return { error: "JSON 解析失敗", raw: text };
    }
  } catch (err) {
    console.error(
      "analyzeImageWithGemini error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return { error: err.response?.data || err.message };
  }
}

// ------- LINE 回覆工具 --------
async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    await axios.post(
      url,
      {
        replyToken,
        messages: [{ type: "text", text }],
      },
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

// ------- 驗證 LINE 簽章 --------
function verifyLineSignature(req, res, next) {
  if (!LINE_CHANNEL_SECRET) {
    // 沒設定 secret，就直接放過（不建議正式環境這樣）
    return next();
  }

  try {
    const signature = req.get("x-line-signature") || "";
    const body = JSON.stringify(req.body);
    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(body)
      .digest("base64");

    if (hash !== signature) {
      console.warn("Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }
    next();
  } catch (e) {
    console.error("verifyLineSignature error:", e.message);
    next();
  }
}

// ------- 記錄圖片 trade --------
async function recordImageTrade({
  symbol = null,
  timeframe = null,
  geminiResult,
}) {
  const trades = await loadTrades();

  const now = new Date().toISOString();
  const data = geminiResult?.data || {};
  const regime = data.regime || "unknown";
  const strategyAllowed =
    typeof data.strategyAllowed === "boolean" ? data.strategyAllowed : null;
  const direction = data.direction || "unknown";

  let r = null;
  if (typeof data.r === "number") {
    r = data.r;
  }

  trades.push({
    id: genId(),
    source: "image",
    createdAt: now,
    symbol,
    timeframe,
    regime,
    strategyAllowed,
    direction,
    r,
    entry: data.entry ?? null,
    stop: data.stop ?? null,
    tp1R: data.tp1R ?? null,
    tp1_5R: data.tp1_5R ?? null,
    reason: data.reason || null,
  });

  await saveTrades(trades);
}

// ------- 記錄文字 trade（簡化版紀錄）--------
async function recordTextTrade({ symbol, timeframe, userText, aiReply }) {
  const trades = await loadTrades();
  const now = new Date().toISOString();

  trades.push({
    id: genId(),
    source: "text",
    createdAt: now,
    symbol: symbol || null,
    timeframe: timeframe || null,
    regime: "unknown",
    strategyAllowed: null,
    direction: "unknown",
    r: null, // 純紀錄，不影響 R 統計
    entry: null,
    stop: null,
    tp1R: null,
    tp1_5R: null,
    reason: null,
    note: userText,
    aiSummary: (aiReply || "").slice(0, 500),
  });

  await saveTrades(trades);
}

// ------- Webhook 主邏輯 --------
app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    try {
      const replyToken = event.replyToken;
      if (event.type !== "message") continue;

      const message = event.message;

      // 文字訊息
      if (message.type === "text") {
        const originalText = message.text || "";
        const { symbol, timeframe, cleanText } = parseMetaFromText(originalText);

        const answer = await askGeminiText(cleanText);
        await replyToLine(replyToken, answer.substring(0, 2000));

        // ➕ 把這則文字問答記錄到 trades.json
        await recordTextTrade({
          symbol,
          timeframe,
          userText: originalText,
          aiReply: answer,
        });
      }

      // 圖片訊息
      else if (message.type === "image") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        let imgBase64 = null;
        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            timeout: 15000,
          });
          imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
        } catch (err) {
          console.error(
            "Failed to download image from LINE:",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
          continue;
        }

        const visionRes = await analyzeImageWithGemini(imgBase64);
        if (visionRes.error) {
          console.error("Gemini Vision error:", visionRes.error);
          await replyToLine(
            replyToken,
            "圖片分析失敗（Gemini Vision）。請稍後再試。"
          );
          continue;
        }

        // 記錄成 trade
        await recordImageTrade({
          symbol: null, // 圖片目前抓不到幣種＋週期，先留空
          timeframe: null,
          geminiResult: visionRes,
        });

        const d = visionRes.data || {};
        const replyText = [
          "📊 圖片分析結果（獵影策略視角）",
          "",
          `盤勢判斷：${d.regime || "unknown"}`,
          `策略可用：${
            typeof d.strategyAllowed === "boolean"
              ? d.strategyAllowed
                ? "✅ 可用"
                : "⛔ 禁用"
              : "unknown"
          }`,
          `方向建議：${d.direction || "unknown"}`,
          "",
          d.reason ? `簡短說明：${d.reason}` : "",
          "",
          "（本結果僅供教育與風險警示，非投資建議）",
        ]
          .filter(Boolean)
          .join("\n");

        await replyToLine(replyToken, replyText.substring(0, 2000));
      }

      // 其他訊息類型
      else {
        await replyToLine(
          replyToken,
          "目前只支援「文字」與「圖片」訊息唷。"
        );
      }
    } catch (err) {
      console.error(
        "Error processing event:",
        err.response?.data || err.message || err
      );
    }
  }

  res.status(200).send("OK");
});

// ------- trades API（Dashboard / 其他用）--------
app.get("/api/trades", async (req, res) => {
  const trades = await loadTrades();
  res.json(trades);
});

// ------- Dashboard 頁面（含篩選器）--------
app.get("/dashboard", async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>獵影策略 Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      margin: 0;
      padding: 16px;
      background: #0b1120;
      color: #e5e7eb;
    }
    h1 {
      margin-bottom: 8px;
    }
    .card {
      background: #020617;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 0 0 1px #1f2937;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .label {
      font-size: 12px;
      color: #9ca3af;
    }
    .value {
      font-size: 20px;
      font-weight: 600;
      margin-top: 4px;
    }
    select, button {
      background: #020617;
      color: #e5e7eb;
      border-radius: 8px;
      border: 1px solid #4b5563;
      padding: 4px 8px;
      margin-right: 8px;
      cursor: pointer;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid #1f2937;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #020617;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tr:nth-child(even) td {
      background: #020617;
    }
    .r-positive { color: #4ade80; }
    .r-negative { color: #f97373; }
    .tag {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid #4b5563;
      margin-right: 4px;
      margin-bottom: 2px;
    }
    .tag-image { border-color: #38bdf8; }
    .tag-text { border-color: #a855f7; }
    canvas {
      max-width: 100%;
    }
  </style>
</head>
<body>
  <h1>獵影策略 Dashboard</h1>
  <div style="margin-bottom: 12px; color:#9ca3af; font-size:13px;">
    這裡會統計 <b>trades.json</b> 裡的資料：圖片分析 & 文字紀錄。
    <br/>只有有數值 R 的紀錄會影響勝率 / Equity Curve，其餘視為註記。
  </div>

  <div class="card">
    <div class="label" style="margin-bottom:4px;">篩選</div>
    <div style="margin-bottom:8px;">
      <label class="label">盤勢：</label>
      <select id="regimeFilter">
        <option value="all">全部</option>
        <option value="consolidation">盤整</option>
        <option value="trend">趨勢</option>
        <option value="unknown">未知</option>
      </select>

      <label class="label">方向：</label>
      <select id="directionFilter">
        <option value="all">全部</option>
        <option value="long">多單</option>
        <option value="short">空單</option>
        <option value="unknown">未知</option>
      </select>

      <label class="label">來源：</label>
      <select id="sourceFilter">
        <option value="all">全部</option>
        <option value="image">圖片分析</option>
        <option value="text">文字紀錄</option>
      </select>

      <button id="resetBtn">重置</button>
    </div>
  </div>

  <div class="card">
    <div class="grid">
      <div>
        <div class="label">有效筆數（有 R 值）</div>
        <div class="value" id="countTrades">-</div>
      </div>
      <div>
        <div class="label">勝率</div>
        <div class="value" id="winRate">-</div>
      </div>
      <div>
        <div class="label">平均 R</div>
        <div class="value" id="avgR">-</div>
      </div>
      <div>
        <div class="label">最大回撤</div>
        <div class="value" id="maxDD">-</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="label" style="margin-bottom:4px;">Equity Curve（R）</div>
    <canvas id="equityChart" height="120"></canvas>
  </div>

  <div class="card" style="max-height:420px; overflow:auto;">
    <div class="label" style="margin-bottom:4px;">最近紀錄</div>
    <table>
      <thead>
        <tr>
          <th>時間</th>
          <th>來源</th>
          <th>商品/週期</th>
          <th>盤勢 / 策略</th>
          <th>方向</th>
          <th>R</th>
          <th>說明 / 註記</th>
        </tr>
      </thead>
      <tbody id="tradesBody"></tbody>
    </table>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    let allTrades = [];
    let chart = null;

    async function fetchTrades() {
      const res = await fetch("/api/trades");
      const data = await res.json();
      allTrades = Array.isArray(data) ? data : [];
      render();
    }

    function applyFilters(trades) {
      const regimeFilter = document.getElementById("regimeFilter").value;
      const directionFilter = document.getElementById("directionFilter").value;
      const sourceFilter = document.getElementById("sourceFilter").value;

      return trades.filter(t => {
        const regime = (t.regime || "unknown");
        const dir = (t.direction || "unknown");
        const src = (t.source || "unknown");

        if (regimeFilter !== "all" && regime !== regimeFilter) return false;
        if (directionFilter !== "all" && dir !== directionFilter) return false;
        if (sourceFilter !== "all" && src !== sourceFilter) return false;
        return true;
      });
    }

    function render() {
      const tradesFiltered = applyFilters(allTrades);

      // 只拿有 R 值的來算績效
      const numeric = tradesFiltered.filter(
        t => typeof t.r === "number" && !Number.isNaN(t.r)
      );

      const count = numeric.length;
      let wins = 0;
      let sumR = 0;
      let equity = 0;
      let maxEquity = 0;
      let maxDrawdown = 0;

      numeric.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const curve = [];

      for (const t of numeric) {
        const r = t.r || 0;
        if (r > 0) wins++;
        sumR += r;
        equity += r;
        if (equity > maxEquity) maxEquity = equity;
        const dd = maxEquity - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
        curve.push({ time: t.createdAt, equity });
      }

      const winRate = count ? (wins / count * 100).toFixed(1) + "%" : "-";
      const avgR = count ? (sumR / count).toFixed(2) : "-";
      const maxDD = count ? maxDrawdown.toFixed(2) + " R" : "-";

      document.getElementById("countTrades").textContent = count;
      document.getElementById("winRate").textContent = winRate;
      document.getElementById("avgR").textContent = avgR;
      document.getElementById("maxDD").textContent = maxDD;

      // 畫 equity chart
      const ctx = document.getElementById("equityChart").getContext("2d");
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: "line",
        data: {
          labels: curve.map((p, idx) => idx + 1),
          datasets: [
            {
              label: "Equity (R)",
              data: curve.map(p => p.equity),
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { labels: { color: "#e5e7eb" } },
          },
          scales: {
            x: {
              ticks: { color: "#9ca3af" },
              grid: { color: "#111827" },
            },
            y: {
              ticks: { color: "#9ca3af" },
              grid: { color: "#111827" },
            },
          },
        },
      });

      // 表格
      const tbody = document.getElementById("tradesBody");
      tbody.innerHTML = "";
      tradesFiltered
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .forEach(t => {
          const tr = document.createElement("tr");

          const createdAt = t.createdAt
            ? new Date(t.createdAt).toLocaleString()
            : "-";

          const srcLabel = t.source === "image"
            ? "圖片"
            : t.source === "text"
            ? "文字"
            : "其他";

          const regime = t.regime || "unknown";
          const dir = t.direction || "unknown";
          const strat =
            typeof t.strategyAllowed === "boolean"
              ? t.strategyAllowed ? "可用" : "禁用"
              : "未知";

          const rStr =
            typeof t.r === "number"
              ? t.r.toFixed(2)
              : "";

          const rClass =
            typeof t.r === "number"
              ? t.r > 0
                ? "r-positive"
                : t.r < 0
                ? "r-negative"
                : ""
              : "";

          const note =
            t.reason ||
            t.aiSummary ||
            t.note ||
            "";

          tr.innerHTML = \`
            <td>\${createdAt}</td>
            <td>
              <span class="tag \${t.source === "image" ? "tag-image" : t.source === "text" ? "tag-text" : ""}">
                \${srcLabel}
              </span>
            </td>
            <td>\${(t.symbol || "-")}<br/><span class="label">\${t.timeframe || ""}</span></td>
            <td>
              <div>盤勢：\${regime}</div>
              <div>策略：\${strat}</div>
            </td>
            <td>\${dir}</td>
            <td class="\${rClass}">\${rStr}</td>
            <td style="max-width:260px; white-space:pre-wrap;">\${note}</td>
          \`;

          tbody.appendChild(tr);
        });
    }

    document.getElementById("regimeFilter").addEventListener("change", render);
    document.getElementById("directionFilter").addEventListener("change", render);
    document.getElementById("sourceFilter").addEventListener("change", render);
    document.getElementById("resetBtn").addEventListener("click", () => {
      document.getElementById("regimeFilter").value = "all";
      document.getElementById("directionFilter").value = "all";
      document.getElementById("sourceFilter").value = "all";
      render();
    });

    fetchTrades();
  </script>
</body>
</html>`);
});

// ------- 啟動 Server --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("LINE Bot webhook listening on port " + PORT)
);
