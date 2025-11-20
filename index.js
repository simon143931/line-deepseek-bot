// index.js
// 🚀 獵影策略 LINE Bot - 頂級升級版
// 功能：
// 1. Google Gemini 強韌請求（自動重試、自我修復）
// 2. 內建 system prompt（獵影策略教練模式）
// 3. 使用者上下文記憶（簡單對話紀錄 / 交易筆記）
// 4. 圖片 → 直接丟給 Gemini 做多模分析（不用 Vision API）
// 5. 語音訊息 → Gemini 聽完幫你轉文字 + 用獵影策略回答
// 6. TradingView Webhook 入口，可自動推播到 LINE
// 7. /health 健康檢查
// 8. LINE 簽章驗證（安全）

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "5mb" }));

// --- Health Check ---
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// --- Env ---
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash"; // 你可以在 .env 改
const TRADINGVIEW_WEBHOOK_SECRET =
  process.env.TRADINGVIEW_WEBHOOK_SECRET || "";
const TRADINGVIEW_PUSH_TO = process.env.TRADINGVIEW_PUSH_TO || ""; // 要推播到的 userId 或 groupId

function redactedKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "..." + k.slice(-4);
}

console.log("=== ENV 概況 ===");
console.log("LINE_CHANNEL_ACCESS_TOKEN:", LINE_CHANNEL_ACCESS_TOKEN ? "SET" : "MISSING");
console.log("LINE_CHANNEL_SECRET:", LINE_CHANNEL_SECRET ? "SET" : "MISSING");
console.log("GOOGLE_AI_MODEL:", GOOGLE_AI_MODEL);
console.log("GOOGLE_AI_API_KEY:", redactedKey(GOOGLE_AI_API_KEY));
console.log("TRADINGVIEW_WEBHOOK_SECRET:", TRADINGVIEW_WEBHOOK_SECRET ? "SET" : "NOT SET");
console.log("TRADINGVIEW_PUSH_TO:", TRADINGVIEW_PUSH_TO || "(empty)");

// --- System Prompt：獵影策略教練 ---
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

5. 用風險警示保護使用者：
- 你不能保證獲利，只能說「根據這個策略，理論上該怎麼做」。
- 當使用者太貪婪或想 All in，你要主動提醒風險與「連虧三單就停止」的規則。
- 你只提供教育性說明，不能給「保證賺錢」或「一定會翻倍」的承諾。`;

// --- 簡易使用者記憶（存在記憶體，服務重啟就清空） ---
const userMemory = new Map(); // key: userId, value: { history: [ {role, text, ts} ] }

function addUserMessage(userId, role, text) {
  if (!userId) return;
  if (!userMemory.has(userId)) {
    userMemory.set(userId, { history: [] });
  }
  const mem = userMemory.get(userId);
  mem.history.push({ role, text, ts: Date.now() });
  // 最多只留 20 筆
  if (mem.history.length > 20) mem.history = mem.history.slice(-20);
}

function buildUserContext(userId) {
  const mem = userMemory.get(userId);
  if (!mem || !mem.history.length) return "（目前沒有任何歷史紀錄。）";
  const lastItems = mem.history.slice(-8);
  const lines = lastItems.map(
    (m) => `${m.role === "user" ? "使用者" : "教練"}：${m.text}`
  );
  return lines.join("\n");
}

// --- Google Gemini 通用請求（帶自我修復） ---
async function askGoogleAI(userText, extraSystemPrompt = "", extraContext = "") {
  if (!GOOGLE_AI_API_KEY) {
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統設定錯誤：AI 金鑰未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-2.0-flash";
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": GOOGLE_AI_API_KEY,
  };

  const fullPrompt =
    (extraSystemPrompt || systemPrompt) +
    "\n\n【使用者最近對話紀錄】\n" +
    (extraContext || "（無紀錄）") +
    "\n\n【這次使用者的問題】\n" +
    (userText || "");

  const bodyContents = {
    contents: [
      {
        role: "user",
        parts: [{ text: fullPrompt }],
      },
    ],
  };

  const altBodies = [
    bodyContents,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: fullPrompt }],
        },
      ],
    },
    { input: fullPrompt },
  ];

  const maxRetry = 2;

  for (let bodyIdx = 0; bodyIdx < altBodies.length; bodyIdx++) {
    let body = altBodies[bodyIdx];
    let attempt = 0;

    while (attempt <= maxRetry) {
      try {
        const res = await axios.post(baseUrl, body, {
          headers,
          timeout: 20000,
        });
        const data = res.data || {};

        const candidateText =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.candidates?.[0]?.content?.text ||
          data?.output?.[0]?.content?.text ||
          data?.outputs?.[0]?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.text ||
          null;

        if (candidateText) return String(candidateText);

        console.warn(
          "Gemini success no text. keys=",
          Object.keys(data || {})
        );
        return JSON.stringify(data).slice(0, 1500);
      } catch (err) {
        attempt++;
        const status = err?.response?.status;
        const respData = err?.response?.data;

        if (status === 400 && (userText || "").length > 500) {
          // 太長試著縮短
          userText = userText.slice(0, 400);
          const newPrompt =
            (extraSystemPrompt || systemPrompt) +
            "\n\n【縮短後問題】\n" +
            userText;
          if (body.contents?.[0]?.parts?.[0]) {
            body.contents[0].parts[0].text = newPrompt;
          }
          continue;
        }

        if (attempt > maxRetry) {
          console.error(
            `askGoogleAI failed bodyIdx=${bodyIdx}, attempts=${attempt}, status=${status}, msg=${err.message}`
          );
          if (respData)
            console.error(
              "Resp snippet:",
              JSON.stringify(respData).slice(0, 800)
            );
          break;
        }

        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  return "⚠️ AI 目前沒有回應（多次嘗試失敗）。請稍後再試，或請管理員檢查 GOOGLE_AI_API_KEY / GOOGLE_AI_MODEL。";
}

// --- Multimodal：圖片 + 語音 ---
// 1) 圖片分析：把 K 線截圖丟給 Gemini
async function analyzeImageWithGemini(base64Image) {
  if (!GOOGLE_AI_API_KEY) return { error: "GOOGLE_AI_API_KEY 未設定" };

  const model = GOOGLE_AI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": GOOGLE_AI_API_KEY,
  };

  const promptText = `
你收到一張交易截圖（可能包含 K 線、OBV、布林通道等）。
請依照「獵影策略」做以下事：

1. 判斷現在是不是盤整行情。
2. 判斷是否出現進場訊號（三種型態：十字星 / 實體吞沒 / 影線吞沒）。
3. 如果有進場機會，簡單講解：
   - 做多還是做空？
   - 建議怎麼設停損（ATR 或影線）。
   - 建議 1R、1.5R 大概怎麼抓。
4. 如果條件不符合，請直接說「建議觀望」並簡短說明原因。
`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemPrompt },
          { text: promptText },
          {
            inline_data: {
              mime_type: "image/png", // LINE 截圖通常是 jpeg/png，這裡用 png 也 ok
              data: base64Image,
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(url, body, { headers, timeout: 30000 });
    return res.data;
  } catch (err) {
    console.error(
      "analyzeImageWithGemini error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return { error: err.response?.data || err.message };
  }
}

// 2) 語音轉文字 + 交給獵影策略
async function transcribeAudioWithGemini(base64Audio, mimeType = "audio/mp4") {
  if (!GOOGLE_AI_API_KEY) return { error: "GOOGLE_AI_API_KEY 未設定" };

  const model = GOOGLE_AI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": GOOGLE_AI_API_KEY,
  };

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              systemPrompt +
              "\n\n你現在先幫我：1）逐字稿轉文字；2）整理成清楚的文字提問；3）依獵影策略回答這個提問。",
          },
          {
            inline_data: {
              mime_type: mimeType, // LINE 語音多半是 audio/m4a 或 audio/aac
              data: base64Audio,
            },
          },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(url, body, { headers, timeout: 60000 });
    return res.data;
  } catch (err) {
    console.error(
      "transcribeAudioWithGemini error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return { error: err.response?.data || err.message };
  }
}

// --- LINE Reply / Push ---
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

async function pushToLine(to, text) {
  if (!to) {
    console.warn("pushToLine: no target id");
    return;
  }
  const url = "https://api.line.me/v2/bot/message/push";
  try {
    await axios.post(
      url,
      { to, messages: [{ type: "text", text }] },
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
      "pushToLine error:",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// --- LINE Signature 驗證 ---
function verifyLineSignature(req, res, next) {
  try {
    if (!LINE_CHANNEL_SECRET) {
      console.warn("LINE_CHANNEL_SECRET 未設定，略過簽章檢查（不建議）");
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

// --- TradingView Webhook ---
// TradingView 設定 Webhook URL 指向 https://你的域名/tradingview
// Body 示範：
// {
//   "secret": "你在 .env 裡設定的 TRADINGVIEW_WEBHOOK_SECRET",
//   "symbol": "{{ticker}}",
//   "price": "{{close}}",
//   "note": "xxx"
// }
app.post("/tradingview", async (req, res) => {
  try {
    if (!TRADINGVIEW_WEBHOOK_SECRET) {
      return res.status(500).send("TRADINGVIEW_WEBHOOK_SECRET not set");
    }
    const { secret, symbol, price, note } = req.body || {};
    if (secret !== TRADINGVIEW_WEBHOOK_SECRET) {
      return res.status(403).send("Forbidden");
    }

    const lines = [];
    lines.push("📡 TradingView 訊號");
    if (symbol) lines.push(`標的：${symbol}`);
    if (price) lines.push(`價格：${price}`);
    if (note) lines.push(`備註：${note}`);

    const text = lines.join("\n");

    if (TRADINGVIEW_PUSH_TO) {
      await pushToLine(TRADINGVIEW_PUSH_TO, text);
    } else {
      console.warn("TRADINGVIEW_PUSH_TO 未設定，只記錄訊號不推播。");
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("TradingView webhook error:", err.message);
    res.status(500).send("Error");
  }
});

// --- LINE Webhook 主邏輯 ---
app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    const replyToken = event.replyToken;
    const source = event.source || {};
    const userId = source.userId || "unknown";

    try {
      if (event.type !== "message") continue;

      const message = event.message;

      // 文字訊息
      if (message.type === "text") {
        const userText = message.text || "";

        // 紀錄使用者說的話
        addUserMessage(userId, "user", userText);
        const context = buildUserContext(userId);

        const answer = await askGoogleAI(userText, systemPrompt, context);
        const replyText = answer.substring(0, 2000);

        addUserMessage(userId, "assistant", replyText);
        await replyToLine(replyToken, replyText);

        // 圖片訊息
      } else if (message.type === "image") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
        let imgBase64 = null;

        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            timeout: 20000,
          });
          imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
        } catch (err) {
          console.error(
            "Download image error:",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
          continue;
        }

        const geminiRes = await analyzeImageWithGemini(imgBase64);
        if (geminiRes.error) {
          await replyToLine(
            replyToken,
            "圖片分析失敗（Gemini）。請稍後再試。"
          );
          continue;
        }

        const text =
          geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "（AI 沒有回應內容）";

        const replyText = `📈 圖片盤勢分析（Gemini）：\n\n${text.substring(
          0,
          1800
        )}`;

        addUserMessage(userId, "assistant", replyText);
        await replyToLine(replyToken, replyText);

        // 語音訊息
      } else if (message.type === "audio") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        let audioBase64 = null;
        try {
          const audioRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            timeout: 30000,
          });
          audioBase64 = Buffer.from(audioRes.data, "binary").toString("base64");
        } catch (err) {
          console.error(
            "Download audio error:",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(replyToken, "語音下載失敗，請稍後再試。");
          continue;
        }

        // LINE 語音通常是 m4a，這裡用 audio/mp4 比較通用
        const tRes = await transcribeAudioWithGemini(
          audioBase64,
          "audio/mp4"
        );
        if (tRes.error) {
          await replyToLine(
            replyToken,
            "語音解析失敗（Gemini）。請改用文字再問一次。"
          );
          continue;
        }

        const text =
          tRes?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "（AI 沒有回應內容）";

        const replyText = `🎙 語音解析結果：\n\n${text.substring(0, 1800)}`;
        addUserMessage(userId, "assistant", replyText);
        await replyToLine(replyToken, replyText);

        // 其他類型
      } else {
        await replyToLine(
          replyToken,
          "目前只支援文字、圖片與語音訊息，其他類型暫不支援。"
        );
      }
    } catch (err) {
      console.error("Error processing event:", err.response?.data || err.message || err);
      if (replyToken) {
        await replyToLine(
          replyToken,
          "⚠️ 系統剛剛出了一點狀況，請稍後再試一次。"
        );
      }
    }
  }

  res.status(200).send("OK");
});

// --- 啟動伺服器 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("LINE Bot webhook listening on port " + PORT)
);
