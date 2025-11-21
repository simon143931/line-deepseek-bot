// index.js
// LINE + Google Gemini (文字 + 圖片) + 簡易交易日誌(trades.json)

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------------- Health Check ----------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------- Env & 基本設定 ----------------------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.warn("Warning: LINE_CHANNEL_ACCESS_TOKEN 未設定。");
}
if (!LINE_CHANNEL_SECRET) {
  console.warn("Warning: LINE_CHANNEL_SECRET 未設定，webhook 驗證將失效。");
}
if (!GOOGLE_AI_API_KEY) {
  console.warn("Warning: GOOGLE_AI_API_KEY 未設定，AI 功能無法使用。");
}

function redactKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "..." + k.slice(-4);
}
console.log(
  `[BOOT] model=${GOOGLE_AI_MODEL}, googleKey=${redactKey(
    GOOGLE_AI_API_KEY
  )}`
);

// ---------------------- 系統 Prompt（獵影策略教練） ----------------------
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
  - 你還缺少哪幾個資訊，才有辦法正確判斷
  - 用最簡單、易懂的形式引導他補充。
(3) 當所有條件齊備後，你要主動完整輸出以下決策報告：
  A. 「此盤勢是否符合盤整？」（是／否 + 判斷依據）
  B. 「是否符合三種進場型態之一？」（是哪一種＋理由）
  C. 「建議進場價格、停損位置（用 ATR 估計）、1R、1.5R 停利點」
  D. 「風險評估與提醒」。
(4) 如果所有條件不成立，你要直接說：
  - 「這不是獵影策略該進場的位置，建議觀望。」並幫他講清楚原因。

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
  - 你還缺「哪幾個關鍵資訊」。
  - 再請他補充數據或更清楚的描述，而不是亂猜。

【圖片識別邏輯】
- 如果使用者傳來圖片（如 K 線截圖、OBV + 布林圖），你要依照獵影策略流程，主動做盤整判斷、進場條件檢查與風險提示。`;

// ---------------------- trades.json 簡易交易日誌 ----------------------
const TRADES_FILE = path.join(process.cwd(), "trades.json");

function ensureTradesFile() {
  try {
    if (!fs.existsSync(TRADES_FILE)) {
      fs.writeFileSync(TRADES_FILE, "[]", "utf8");
    }
  } catch (e) {
    console.error("確保 trades.json 存在時發生錯誤:", e.message);
  }
}

function loadTrades() {
  try {
    ensureTradesFile();
    const raw = fs.readFileSync(TRADES_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("讀取 trades.json 失敗:", e.message);
    return [];
  }
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), "utf8");
  } catch (e) {
    console.error("寫入 trades.json 失敗:", e.message);
  }
}

function appendTrade(note) {
  const trades = loadTrades();
  trades.push({
    id: trades.length + 1,
    time: new Date().toISOString(),
    note,
  });
  saveTrades(trades);
}

function formatRecentTrades(limit = 5) {
  const trades = loadTrades();
  if (!trades.length) return "目前還沒有任何交易紀錄。";

  const recent = trades.slice(-limit);
  return (
    "以下是最近幾筆交易紀錄：\n" +
    recent
      .map(
        (t) =>
          `#${t.id} - ${t.time}\n${t.note}\n------------------------`
      )
      .join("\n")
  );
}

// ---------------------- Google Gemini (文字 + 圖片) ----------------------
async function askGoogleAI(userText, options = {}) {
  if (!GOOGLE_AI_API_KEY) {
    return "⚠️ 系統設定錯誤：AI 金鑰未設定，請聯絡管理員。";
  }

  const { imageBase64, imageMimeType } = options;

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const parts = [];

  // 把獵影策略 systemPrompt + 使用者問題一起丟給模型
  parts.push({
    text: `${systemPrompt}\n\n【使用者的問題／情境】\n${userText || ""}`,
  });

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: imageMimeType || "image/jpeg",
        data: imageBase64,
      },
    });
  }

  const body = {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
  };

  try {
    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
    });

    const data = res.data || {};
    const candidates = data.candidates || [];
    if (!candidates.length) {
      console.warn("Gemini 回傳沒有 candidates，data keys:", Object.keys(data));
      return "⚠️ AI 沒有給出任何回應，請稍後再試。";
    }

    const partsOut = candidates[0].content?.parts || [];
    const text =
      partsOut
        .map((p) => p.text)
        .filter(Boolean)
        .join("\n")
        .trim() || "⚠️ AI 回傳內容為空白。";

    return text;
  } catch (err) {
    const status = err.response?.status;
    const respData = err.response?.data;
    console.error(
      "askGoogleAI error:",
      status,
      err.message,
      respData ? JSON.stringify(respData).slice(0, 500) : ""
    );

    if (status === 401 || status === 403) {
      return "⚠️ AI 權限錯誤（401/403），請檢查 GOOGLE_AI_API_KEY 是否正確或有使用權限。";
    }

    return "⚠️ AI 目前無法回應，可能伺服器忙碌或設定有誤，請稍後再試。";
  }
}

// ---------------------- LINE 回覆工具 ----------------------
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

// ---------------------- LINE 簽名驗證 Middleware ----------------------
function verifyLineSignature(req, res, next) {
  if (!LINE_CHANNEL_SECRET) {
    // 沒設定就直接略過驗證（不安全，但避免開發時卡住）
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

// ---------------------- Webhook 主邏輯 ----------------------
app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      const replyToken = event.replyToken;
      const message = event.message;

      // 1) 文字訊息
      if (message.type === "text") {
        const userText = (message.text || "").trim();

        // --- 交易日誌：紀錄 ---
        if (/^(紀錄|記錄)/.test(userText)) {
          appendTrade(userText);
          await replyToLine(
            replyToken,
            "✅ 已幫你把這一筆交易紀錄寫進 trades.json。\n之後可以輸入「查紀錄」看最近幾筆。"
          );
          continue;
        }

        // --- 交易日誌：查詢 ---
        if (/^(查紀錄|查記錄)/.test(userText)) {
          const out = formatRecentTrades(5);
          await replyToLine(replyToken, out.substring(0, 2000));
          continue;
        }

        // --- 一般獵影策略教練問答 ---
        const answer = await askGoogleAI(userText);
        await replyToLine(replyToken, answer.substring(0, 2000));
      }

      // 2) 圖片訊息：改用 Gemini Vision（不用 Cloud Vision API）
      else if (message.type === "image") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        let imgBase64 = null;
        let mimeType = "image/jpeg";

        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: {
              Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            timeout: 15000,
          });

          mimeType =
            imgRes.headers["content-type"] ||
            imgRes.headers["Content-Type"] ||
            "image/jpeg";

          imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
        } catch (err) {
          console.error(
            "下載 LINE 圖片失敗:",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(
            replyToken,
            "⚠️ 圖片下載失敗，請稍後再傳一次看看。"
          );
          continue;
        }

        const visionPrompt =
          "這是一張 K 線 / 指標 / OBV + 布林帶 的截圖，請完全依照上面的《獵影策略》規則，幫我做：\n" +
          "1. 判斷目前是否為盤整行情？\n" +
          "2. 有沒有符合三種進場型態之一（十字星 / 實體吞沒 / 影線吞沒）？\n" +
          "3. 如果可進場，建議方向（多 / 空）、大概停損位置與 1R~1.5R 停利區間。\n" +
          "4. 如果條件不符合，請直接說「建議觀望」並說明原因。\n" +
          "如果圖片資訊不足，你要明確說出還缺哪些關鍵資訊。";

        const answer = await askGoogleAI(visionPrompt, {
          imageBase64: imgBase64,
          imageMimeType: mimeType,
        });

        await replyToLine(replyToken, answer.substring(0, 2000));
      }

      // 3) 其他訊息類型
      else {
        await replyToLine(
          replyToken,
          "目前只支援「文字」與「圖片」訊息，其它類型暫時不處理。"
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

// ---------------------- 啟動伺服器 ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("LINE Bot webhook listening on port " + PORT);
});
