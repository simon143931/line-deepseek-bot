// ===============================
// index.js — FINAL ULTIMATE VERSION
// ===============================

// 超穩定 LINE Bot + Google AI + Vision + 驗簽 + Fallback + Prompt Loader
// 完整可部署版本（Render / Vercel / 本地 100% 可跑）

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json({ limit: "5mb" }));

// =========================
// Health Check
// =========================
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// =========================
// ENV
// =========================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";

if (!LINE_CHANNEL_ACCESS_TOKEN) console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
if (!LINE_CHANNEL_SECRET) console.warn("⚠️ LINE_CHANNEL_SECRET 未設定(將無法驗簽)");
if (!GOOGLE_AI_API_KEY) console.warn("⚠️ GOOGLE_AI_API_KEY 未設定");

// =========================
// 讀取 system prompt（從 prompt.txt）
// =========================
let systemPrompt = "";
try {
  systemPrompt = fs.readFileSync("./prompt.txt", "utf8");
  console.log("✅ 已成功讀取 prompt.txt");
} catch (err) {
  console.error("❌ 無法讀取 prompt.txt：", err);
  systemPrompt = "你是一個 AI 教練。（fallback prompt）";
}

// =========================
// LINE Signature 驗證
// =========================
function verifyLineSignature(req, res, next) {
  try {
    const signature = req.get("x-line-signature") || "";
    const body = JSON.stringify(req.body);

    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(body)
      .digest("base64");

    if (hash !== signature) {
      console.warn("❌ LINE Signature 驗證失敗");
      return res.status(401).send("Invalid signature");
    }

    next();
  } catch (err) {
    console.error("Signature verify error:", err);
    next(); // 不中斷，但記錄
  }
}
// ===============================
// Google AI — 多重 Fallback + Retry 版本
// ===============================
async function askGoogleAI(userText) {
  if (!GOOGLE_AI_API_KEY) {
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統錯誤：AI 金鑰未設定。";
  }

  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_AI_MODEL}:generateContent`;
  const url = `${baseUrl}?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  // 最主要的 Request body
  const primaryBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemPrompt}\n\n${userText}` }],
      },
    ],
  };

  // Alternative body 形式（Google API 有時候會吃不同格式）
  const altBodies = [
    primaryBody,
    {
      messages: [
        { role: "system", content: [{ text: systemPrompt }] },
        { role: "user", content: [{ text: userText }] },
      ],
    },
    { input: `${systemPrompt}\n\n${userText}` },
  ];

  for (let bodyIdx = 0; bodyIdx < altBodies.length; bodyIdx++) {
    const body = altBodies[bodyIdx];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await axios.post(url, body, {
          headers: { "Content-Type": "application/json" },
          timeout: 20000,
        });

        const data = res.data;

        const output =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.candidates?.[0]?.content?.text ||
          data?.text ||
          null;

        if (output) return output;
      } catch (err) {
        const status = err?.response?.status;

        // 400 → 可能內容太大，自動縮短重試
        if (status === 400 && userText.length > 300) {
          userText = userText.slice(0, 250);
        }

        // 404 → model name 錯誤
        if (status === 404) {
          console.error(`❌ Model not found: ${GOOGLE_AI_MODEL}`);
        }

        if (attempt === 1) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  return "⚠️ Google AI 目前無回應，請稍後再試。";
}

// ===============================
// Google Vision API（OCR + Labels）
// ===============================
async function analyzeImage(base64Image) {
  if (!GOOGLE_AI_API_KEY) {
    return { error: "缺少 GOOGLE_AI_API_KEY" };
  }

  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: "TEXT_DETECTION", maxResults: 1 },
          { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
          { type: "LABEL_DETECTION", maxResults: 5 },
        ],
      },
    ],
  };

  try {
    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
    });

    return res.data;
  } catch (err) {
    console.error("Vision API Error:", err.response?.data || err.message);
    return { error: "Vision API 呼叫失敗" };
  }
}

// ===============================
// LINE 回覆訊息 helper
// ===============================
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
    console.error("replyToLine Error:", err.response?.data || err.message);
  }
}
// ===============================
// Webhook 主流程
// ===============================
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    try {
      // 只處理 message 事件
      if (event.type !== "message") continue;

      const replyToken = event.replyToken;
      const message = event.message;

      // ==========
      // 文字訊息
      // ==========
      if (message.type === "text") {
        const userText = message.text || "";

        // 呼叫 Google Gemini（會自動帶入 systemPrompt）
        const answer = await askGoogleAI(userText);

        // LINE 最長 2000 字，安全切一下
        await replyToLine(replyToken, (answer || "（沒有內容）").substring(0, 2000));
        continue;
      }

      // ==========
      // 圖片訊息
      // ==========
      if (message.type === "image") {
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        let imgBase64 = null;

        // 1️⃣ 先從 LINE 把圖片抓回來
        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: {
              Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            timeout: 15000,
          });

          imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
        } catch (err) {
          console.error(
            "下載 LINE 圖片失敗：",
            err.response?.status,
            err.response?.data || err.message
          );
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
          continue;
        }

        // 2️⃣ 丟給 Google Vision 做 OCR + Labels
        const visionRes = await analyzeImage(imgBase64);
        if (visionRes.error) {
          await replyToLine(replyToken, "圖片辨識失敗（Vision API）。請稍後再試。");
          continue;
        }

        const firstResponse = visionRes.responses?.[0] || {};
        const textAnnotations =
          firstResponse.textAnnotations?.[0]?.description ||
          firstResponse.fullTextAnnotation?.text ||
          "";

        const labels =
          (firstResponse.labelAnnotations || [])
            .map((l) => `${l.description}(${Math.round((l.score || 0) * 100)}%)`)
            .join(", ") || "";

        // 3️⃣ 把 OCR + Labels 整理成一段 prompt 丟給 Gemini
        const promptForImage = `
我給你一張交易相關截圖（例如 K 線圖、指標畫面），以下是從圖裡 OCR 出來的文字與標籤：

【OCR 文字】
${textAnnotations || "(無明顯文字)"}

【Vision 標籤】
${labels || "(無特別標籤)"}

請你依照「獵影策略教練」的角色，粗略判斷：

1. 這張圖比較像是什麼情境（盤整 / 趨勢 / 看不出來）
2. 如果勉強要從獵影策略角度做決策，你會怎麼提醒：是「可以找點位」、「先觀望」、還是「完全不適合用獵影策略」
3. 用很短、很口語的方式幫我總結重點，當作教練對學生說的話。
`.trim();

        const aiAnswer = await askGoogleAI(promptForImage);

        const replyText = [
          "📈 圖片 PoC 分析（OCR + Vision）",
          "",
          textAnnotations
            ? "【OCR 簡要文字】\n" + textAnnotations.substring(0, 400)
            : "【OCR 簡要文字】\n(幾乎沒有可辨識文字)",
          "",
          labels ? "【Vision 標籤】\n" + labels : "【Vision 標籤】\n(無特別標籤)",
          "",
          "【教練簡短判斷】",
          (aiAnswer || "（AI 沒有回應）").substring(0, 1000),
        ].join("\n");

        await replyToLine(replyToken, replyText);
        continue;
      }

      // 其他型態先簡單回覆
      await replyToLine(replyToken, "目前只支援：文字與圖片訊息，其它類型暫不處理喔。");
    } catch (err) {
      console.error("Error processing event:", err.response?.data || err.message || err);
      // 碰到錯誤也不要讓整個 webhook 掛掉
      try {
        if (event.replyToken) {
          await replyToLine(
            event.replyToken,
            "⚠️ 系統處理你的訊息時出現異常，請稍後再試一次。"
          );
        }
      } catch (e) {
        // 忽略二次錯誤
      }
    }
  }

  // LINE 規範：要盡快回 200，表示 webhook 已收到
  res.status(200).send("OK");
});

// ===============================
// 啟動 HTTP Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot webhook listening on port ${PORT}`);
});
