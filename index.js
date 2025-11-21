// index.js
// LINE Bot + Gemini (文字 + 圖片) + 交易紀錄 + 風控 + 簡易 Dashboard

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ------------------------- 環境變數 & 基本設定 -------------------------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-1.5-flash";

const TRADES_FILE = "./trades.json";

// 健康檢查
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

function redactedKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "..." + k.slice(-4);
}

console.log("=== Bot 啟動設定 ===");
console.log("LINE_CHANNEL_ACCESS_TOKEN:", LINE_CHANNEL_ACCESS_TOKEN ? "set" : "MISSING");
console.log("LINE_CHANNEL_SECRET:", LINE_CHANNEL_SECRET ? "set" : "MISSING");
console.log("GOOGLE_AI_MODEL:", GOOGLE_AI_MODEL);
console.log("GOOGLE_AI_API_KEY:", redactedKey(GOOGLE_AI_API_KEY));
console.log("===================");

// ------------------------- LINE 簽章驗證 -------------------------
function verifyLineSignature(req, res, next) {
  try {
    if (!LINE_CHANNEL_SECRET) {
      console.warn("LINE_CHANNEL_SECRET 未設定，跳過簽章驗證（不建議正式環境這樣做）");
      return next();
    }
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

// ------------------------- 獵影策略 system prompt -------------------------
const systemPrompt = `
你是一位專門教學「獵影策略」的交易教練 AGENT。

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
2. 每次回答問題時，盡量依照：
   A. 先判斷「這個情境是否適用獵影策略」。
   B. 如果適用，逐步拆解：
      - 第 1 步：先看 OBV 與布林帶狀況
      - 第 2 步：檢查三種 K 棒型態是否成立
      - 第 3 步：說明進場方式（市價 / 掛單在哪裡）
      - 第 4 步：如何依 ATR 設停損
      - 第 5 步：如何設 1R ~ 1.5R 停利
   C. 如果不適用，直接說明為何不適用，並提醒使用者最好空手觀望。

3. 如果使用者只問「能不能進場？」或描述很少，你要主動幫他檢查：
   - 現在是否為盤整行情？（依 OBV + 布林帶規則）
   - 有沒有符合三種 K 棒進場型態之一？（十字星、實體吞沒、影線吞沒）
   - ATR 的距離有沒有足夠風險收益比？（至少 1R 以上）
   - 有沒有連虧三單、應該暫停交易？

   資訊不足時，要清楚告訴他還缺哪些關鍵資訊，並用簡單的方式引導補充，而不是亂猜。

4. 如果使用者問的是觀念問題（例：什麼是十字星？為什麼要等收盤？）：
   - 用生活化比喻、條列說明，讓交易小白也看得懂。
   - 可以參考《獵影策略》的精神，但不要整段照抄，要用你自己的話重述。

5. 風險警示：
   - 你不能保證獲利，只能說「根據這個策略，理論上該怎麼做」。
   - 當使用者太貪婪或想 All in，你要主動提醒風險與「連虧三單就停止」的規則。
   - 你只提供教育性說明，不能給「保證賺錢」或「一定會翻倍」的承諾。

【圖片處理】
- 收到 K 線 / 指標截圖時，你要盡量從圖中推斷：
  - OBV 與 MA、布林帶關係
  - 當前 K 棒是否為：十字星 / 實體吞沒 / 影線吞沒 / 都不是
  - 盤整 or 趨勢

【機器決策輸出格式（給後端程式用）】
不管使用者問什麼，每一次回答的最後一行，你都要輸出一段「純 JSON」，不要加任何多餘文字或註解，格式如下：

{"is_trade": false, "symbol": "", "direction": "", "entry": null, "stop": null, "tp1": null, "tp15": null, "risk_r": 1, "note": "簡短說明這次回覆的性質（例如：純教學 / 盤整判斷 / 真正進場建議）"}

說明：
- 如果這次有給出「明確進場建議」，請：
  - is_trade 設為 true
  - symbol：例如 "BTCUSDT"（如果不知道，盡量從用戶文字判斷）
  - direction："long" 或 "short"
  - entry / stop / tp1 / tp15：用數字（價格），不知道就用 null
  - risk_r：這一單預期最大虧損約幾 R，不知道就設為 1
  - note：20 字內說明進場邏輯（例如："OBV 回到 MA 上方 + 十字星"）

- 如果這次是純理論教學 / 心態 / 沒有下單建議，請：
  - is_trade 設為 false
  - 其他欄位可以是空字串或 null

這個 JSON 一定要是整個回覆的最後一行。
`;

// ------------------------- trades.json 讀寫 & 風控 -------------------------

function loadTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    const raw = fs.readFileSync(TRADES_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("loadTrades error:", e.message);
    return [];
  }
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (e) {
    console.error("saveTrades error:", e.message);
  }
}

function addTradeFromSummary(summary) {
  const trades = loadTrades();
  const now = new Date().toISOString();
  const trade = {
    id: Date.now(),
    time: now,
    symbol: summary.symbol || "",
    direction: summary.direction || "",
    entry: summary.entry ?? null,
    stop: summary.stop ?? null,
    tp1: summary.tp1 ?? null,
    tp15: summary.tp15 ?? null,
    risk_r: typeof summary.risk_r === "number" ? summary.risk_r : 1,
    note: summary.note || "",
    result: "pending", // 之後用 #結果 勝 / 敗 來更新
    closedAt: null,
  };
  trades.push(trade);
  saveTrades(trades);
  return trade;
}

function computeStats(trades) {
  const finished = trades.filter((t) => t.result === "win" || t.result === "loss");
  const total = finished.length;
  const wins = finished.filter((t) => t.result === "win").length;
  const losses = finished.filter((t) => t.result === "loss").length;
  const winRate = total ? Math.round((wins / total) * 100) : 0;

  // 累積 R（win +R, loss -R）
  const totalR = finished.reduce((sum, t) => {
    const r = typeof t.risk_r === "number" ? Math.abs(t.risk_r) : 1;
    return sum + (t.result === "win" ? r : -r);
  }, 0);

  // 連虧次數（從最後一筆往回數）
  let consecutiveLoss = 0;
  for (let i = finished.length - 1; i >= 0; i--) {
    if (finished[i].result === "loss") consecutiveLoss++;
    else break;
  }

  return { total, wins, losses, winRate, totalR, consecutiveLoss };
}

function evaluateRiskBeforeNewTrade() {
  const trades = loadTrades();
  const stats = computeStats(trades);

  // 風控規則（可以之後再調整）：
  const maxConsecutiveLoss = 3; // 連虧 3 單停
  const maxDailyLossR = -3; // 當日累積 -3R 停

  // 檢查連虧
  if (stats.consecutiveLoss >= maxConsecutiveLoss) {
    return {
      allow: false,
      message:
        `⚠️ 風控提醒：你已連續虧損 ${stats.consecutiveLoss} 單。\n` +
        `依照獵影策略風控，建議暫停交易、只觀察盤勢。\n` +
        `這次我會照樣給你分析，但不紀錄成新的一筆交易。`,
    };
  }

  // 簡易「當日 R」計算：只粗略看 closedAt 在今天的
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const finishedToday = trades.filter(
    (t) =>
      (t.result === "win" || t.result === "loss") &&
      ((t.closedAt && t.closedAt.startsWith(todayStr)) ||
        (!t.closedAt && t.time && t.time.startsWith(todayStr))),
  );

  const todayR = finishedToday.reduce((sum, t) => {
    const r = typeof t.risk_r === "number" ? Math.abs(t.risk_r) : 1;
    return sum + (t.result === "win" ? r : -r);
  }, 0);

  if (todayR <= maxDailyLossR) {
    return {
      allow: false,
      message:
        `⚠️ 風控提醒：你今天累積約 ${todayR.toFixed(2)} R 虧損，已達每日風控上限（約 ${maxDailyLossR} R）。\n` +
        `今天不建議再開新倉，先休息、復盤會更安全。這次我一樣幫你分析，但不紀錄成新的一筆交易。`,
    };
  }

  return { allow: true, message: "" };
}

// 處理 #結果 勝 / #結果 敗 指令，更新上一筆 pending 交易
async function handleResultCommand(replyToken, userText) {
  const lower = userText.toLowerCase();

  const isWin = lower.includes("勝") || lower.includes("贏") || lower.includes("win");
  const isLoss = lower.includes("敗") || lower.includes("虧") || lower.includes("輸") || lower.includes("loss");

  if (!isWin && !isLoss) {
    await replyToLine(
      replyToken,
      "要更新交易結果，請這樣輸入：\n\n#結果 勝\n或\n#結果 敗",
    );
    return;
  }

  const trades = loadTrades();
  if (!trades.length) {
    await replyToLine(replyToken, "目前沒有任何交易紀錄，先讓我幫你找一個進場點再說吧。");
    return;
  }

  // 找最後一筆 result 不是 win / loss 的
  let idx = -1;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (!trades[i].result || trades[i].result === "pending") {
      idx = i;
      break;
    }
  }

  if (idx === -1) {
    await replyToLine(replyToken, "目前沒有未結束的交易紀錄，可以先讓我幫你找新的進場機會。");
    return;
  }

  trades[idx].result = isWin ? "win" : "loss";
  trades[idx].closedAt = new Date().toISOString();
  saveTrades(trades);

  const stats = computeStats(trades);
  const txt =
    `已更新上一筆交易結果為：${isWin ? "✅ 勝" : "❌ 敗"}。\n\n` +
    `目前統計（已結束）：\n` +
    `- 總筆數：${stats.total}\n` +
    `- 勝率：約 ${stats.winRate}%\n` +
    `- 連續虧損：${stats.consecutiveLoss} 單\n` +
    `- 累積 R 值：約 ${stats.totalR.toFixed(2)} R`;

  await replyToLine(replyToken, txt);
}

// 解析 Gemini 回覆最後一行 JSON
function extractDecisionSummary(fullAnswer) {
  try {
    const lines = fullAnswer.trim().split("\n");
    if (!lines.length) return null;
    const lastLine = lines[lines.length - 1].trim();
    if (!lastLine.startsWith("{") || !lastLine.endsWith("}")) return null;
    const summary = JSON.parse(lastLine);
    return summary;
  } catch (e) {
    return null;
  }
}

// 把 Gemini 回覆 + 風控 + 記錄交易 串起來
function applyRiskAndMaybeLog(fullAnswer) {
  const summary = extractDecisionSummary(fullAnswer);

  if (!summary || !summary.is_trade) {
    // 純教學 / 沒有進場建議，直接原樣回
    return fullAnswer;
  }

  // 先做風控檢查
  const risk = evaluateRiskBeforeNewTrade();
  if (!risk.allow) {
    // 給風控警告，但不紀錄交易
    return `${risk.message}\n\n${fullAnswer}`;
  }

  // 通過風控，紀錄這一筆建議
  addTradeFromSummary(summary);

  const trades = loadTrades();
  const stats = computeStats(trades);

  const extra =
    `\n\n——\n` +
    `📊 目前簡易統計（已結束交易）：\n` +
    `- 總筆數：${stats.total}\n` +
    `- 勝率：約 ${stats.winRate}%\n` +
    `- 連續虧損：${stats.consecutiveLoss} 單\n` +
    `- 累積 R 值：約 ${stats.totalR.toFixed(2)} R\n` +
    `※ 出場後記得用「#結果 勝」或「#結果 敗」更新，風控才會幫你擋子彈。`;

  return fullAnswer + extra;
}

// ------------------------- Gemini 文字 & 圖片 -------------------------

async function askGoogleAI(userText, sysPrompt = "") {
  if (!GOOGLE_AI_API_KEY) {
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統設定錯誤：GOOGLE_AI_API_KEY 未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              (sysPrompt || systemPrompt) +
              "\n\n下面是使用者的輸入，請依照上面的獵影策略與風控規則回答，最後一行輸出純 JSON 決策摘要。\n\n" +
              userText,
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
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("\n").trim();
    return text || "（AI 沒有回覆內容）";
  } catch (err) {
    console.error(
      "askGoogleAI error:",
      err.response?.status,
      err.response?.data || err.message,
    );
    return "⚠️ AI 回應失敗，請稍後再試。";
  }
}

async function askGeminiVision(base64Image, extraUserText = "") {
  if (!GOOGLE_AI_API_KEY) {
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統設定錯誤：GOOGLE_AI_API_KEY 未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const promptText =
    systemPrompt +
    "\n\n這是一張使用者提供的 K 線 / 指標截圖，請依《獵影策略》幫忙判斷盤整 / 趨勢、是否有進場訊號，並在最後一行輸出純 JSON 決策摘要。使用者補充說明（如有）：\n" +
    (extraUserText || "");

  const body = {
    contents: [
      {
        parts: [
          { text: promptText },
          {
            inline_data: {
              mime_type: "image/jpeg",
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
      timeout: 40000,
    });

    const data = res.data || {};
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("\n").trim();
    return text || "（AI 沒有針對圖片給出內容）";
  } catch (err) {
    console.error(
      "askGeminiVision error:",
      err.response?.status,
      err.response?.data || err.message,
    );
    return "⚠️ 圖片分析失敗，請稍後再試。";
  }
}

// ------------------------- LINE 回覆工具 -------------------------

async function replyToLine(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    await axios.post(
      url,
      {
        replyToken,
        messages: [
          {
            type: "text",
            text: text.slice(0, 2000),
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
  } catch (err) {
    console.error(
      "replyToLine error:",
      err.response?.status,
      err.response?.data || err.message,
    );
  }
}

// ------------------------- Dashboard（簡易網頁） -------------------------

app.get("/dashboard", (req, res) => {
  const trades = loadTrades();
  const stats = computeStats(trades);

  const rows = trades
    .map((t) => {
      return `
      <tr>
        <td>${new Date(t.time).toLocaleString("zh-TW")}</td>
        <td>${t.symbol || ""}</td>
        <td>${t.direction || ""}</td>
        <td>${t.entry ?? ""}</td>
        <td>${t.stop ?? ""}</td>
        <td>${t.tp1 ?? ""}</td>
        <td>${t.tp15 ?? ""}</td>
        <td>${t.risk_r ?? ""}</td>
        <td>${t.result || "pending"}</td>
        <td>${t.note || ""}</td>
      </tr>
    `;
    })
    .join("\n");

  const html = `
  <!DOCTYPE html>
  <html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <title>獵影策略 Dashboard</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 20px; background: #111; color: #eee; }
      h1 { margin-bottom: 0.2rem; }
      .stats { margin-bottom: 1rem; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; }
      th, td { border: 1px solid #444; padding: 4px 6px; text-align: center; }
      th { background: #222; }
      tr:nth-child(even) { background: #181818; }
      tr:nth-child(odd) { background: #131313; }
      .tag { display:inline-block; padding:2px 6px; border-radius:4px; background:#333; margin-right:6px; font-size:12px; }
    </style>
  </head>
  <body>
    <h1>獵影策略 Dashboard</h1>
    <div class="stats">
      <div class="tag">已結束總筆數：${stats.total}</div>
      <div class="tag">勝率：約 ${stats.winRate}%</div>
      <div class="tag">連續虧損：${stats.consecutiveLoss} 單</div>
      <div class="tag">累積 R 值：約 ${stats.totalR.toFixed(2)} R</div>
      <p style="margin-top:8px;color:#aaa;">※ 出場後記得在 LINE 裡輸入「#結果 勝」或「#結果 敗」，這邊的統計才會更新。</p>
    </div>
    <table>
      <thead>
        <tr>
          <th>時間</th>
          <th>標的</th>
          <th>方向</th>
          <th>進場</th>
          <th>停損</th>
          <th>TP 1R</th>
          <th>TP 1.5R</th>
          <th>Risk R</th>
          <th>結果</th>
          <th>備註</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="10">目前還沒有任何交易紀錄。</td></tr>'}
      </tbody>
    </table>
  </body>
  </html>
  `;

  res.send(html);
});

// ------------------------- LINE Webhook -------------------------

app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    try {
      const replyToken = event.replyToken;
      if (!replyToken) continue;
      if (event.type !== "message") continue;

      const message = event.message;

      // 文字訊息
      if (message.type === "text") {
        const userText = (message.text || "").trim();

        // 特殊指令：#結果 勝 / 敗
        if (userText.startsWith("#結果")) {
          await handleResultCommand(replyToken, userText);
          continue;
        }

        const aiAnswer = await askGoogleAI(userText, systemPrompt);
        const finalReply = applyRiskAndMaybeLog(aiAnswer);
        await replyToLine(replyToken, finalReply);
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
            "下載 LINE 圖片失敗:",
            err.response?.status,
            err.response?.data || err.message,
          );
          await replyToLine(
            replyToken,
            "圖片下載失敗，請稍後再傳一次截圖看看。",
          );
          continue;
        }

        const aiAnswer = await askGeminiVision(imgBase64);
        const finalReply = applyRiskAndMaybeLog(aiAnswer);
        await replyToLine(replyToken, finalReply);
      }

      // 其他類型先簡單回覆
      else {
        await replyToLine(
          replyToken,
          "目前只支援文字與圖片訊息，其它類型暫時不處理。",
        );
      }
    } catch (err) {
      console.error("Error processing event:", err.response?.data || err.message || err);
    }
  }

  res.status(200).send("OK");
});

// ------------------------- 啟動伺服器 -------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("LINE Bot webhook listening on port " + PORT);
});
