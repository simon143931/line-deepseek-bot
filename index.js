// index.js — Upgraded LINE + Google Generative AI integration
// Node 18+ (ESM style). Put your env in .env (LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, GOOGLE_AI_API_KEY, GOOGLE_AI_MODEL)

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();

// Capture raw body for signature verification while still parsing JSON
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf; // keep raw buffer for HMAC
    },
  })
);

// Health check
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Env
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-1.5-flash";
const PORT = process.env.PORT || 3000;

// Basic checks
if (!LINE_CHANNEL_ACCESS_TOKEN) console.warn("Warning: LINE_CHANNEL_ACCESS_TOKEN 未設定。");
if (!LINE_CHANNEL_SECRET) console.warn("Warning: LINE_CHANNEL_SECRET 未設定（無法驗證 LINE webhook 簽章）。");
if (!GOOGLE_AI_API_KEY) console.warn("Warning: GOOGLE_AI_API_KEY 未設定。");

function redactedKey(k) {
  if (!k) return "(empty)";
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
console.log(`Starting bot — model=${GOOGLE_AI_MODEL}, key=${redactedKey(GOOGLE_AI_API_KEY)}`);

// === system prompt (your strategy) ===
const systemPrompt = `你是一位專門教學「獵影策略」的交易教練 AGENT。
（略：此處請保留你原本的長 system prompt — 若檔案過長可載入外部檔案）`;
// If you prefer to keep the long prompt exactly, replace the above with the full text block.

// -------------------- Helpers --------------------
async function tryPost(url, body, headers = {}) {
  try {
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json", ...headers }, timeout: 20000 });
    return { ok: true, res };
  } catch (err) {
    return { ok: false, err };
  }
}

// Robust askGoogleAI: supports different body shapes, handles 400/404, backoff, no API key leakage
async function askGoogleAI(userText = "", systemPromptLocal = "") {
  if (!GOOGLE_AI_API_KEY) {
    console.error("askGoogleAI: missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統設定錯誤：AI 金鑰未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-1.5-flash";
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const isBearerLike = /^ya29|^ya29-/.test(GOOGLE_AI_API_KEY) || GOOGLE_AI_API_KEY.startsWith("ya29");
  const headers = { "Content-Type": "application/json" };
  if (isBearerLike) headers["Authorization"] = `Bearer ${GOOGLE_AI_API_KEY}`;
  const urlWithKey = isBearerLike ? baseUrl : `${baseUrl}?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  const bodyContents = {
    contents: [{ role: "user", parts: [{ text: (systemPromptLocal || "") + "\n\n" + (userText || "") }] }],
  };
  const altBodies = [
    bodyContents,
    { messages: [{ role: "system", content: [{ text: systemPromptLocal || "" }] }, { role: "user", content: [{ text: userText || "" }] }] },
    { input: (systemPromptLocal || "") + "\n\n" + (userText || "") },
  ];

  for (let bodyIdx = 0; bodyIdx < altBodies.length; bodyIdx++) {
    let body = JSON.parse(JSON.stringify(altBodies[bodyIdx])); // clone to safely mutate
    let attempt = 0;
    const maxRetry = 2;

    while (attempt <= maxRetry) {
      try {
        const res = await axios.post(urlWithKey, body, { headers, timeout: 20000 });
        const data = res.data || {};

        const candidateText =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.candidates?.[0]?.content?.text ||
          data?.output?.[0]?.content?.text ||
          data?.outputs?.[0]?.candidates?.[0]?.content?.parts?.[0]?.text ||
          (data?.responses?.[0]?.items?.map ? data.responses[0].items.map((i) => i.text).join("\n") : null) ||
          data?.text ||
          null;

        if (candidateText) return String(candidateText);
        // fallback: return truncated JSON (safe)
        console.warn("askGoogleAI: no candidate text, returning truncated response keys.");
        return JSON.stringify(Object.keys(data)).slice(0, 1000);
      } catch (err) {
        attempt++;
        const status = err?.response?.status;
        const respData = err?.response?.data;

        // If 400 and userText big, shorten and retry
        if (status === 400 && (userText || "").length > 500) {
          userText = userText.slice(0, 400);
          if (body.contents && body.contents[0] && body.contents[0].parts) {
            body.contents[0].parts[0].text = (systemPromptLocal || "") + "\n\n" + userText;
          }
          continue;
        }

        if (status === 404) {
          console.error(`askGoogleAI: 404 Not Found for model=${model}. BodyIdx=${bodyIdx}.`);
        }

        if (attempt > maxRetry) {
          console.error(`askGoogleAI failed (bodyIdx=${bodyIdx}) after ${attempt} attempts. status=${status}`);
          if (respData) console.error("Response snippet:", JSON.stringify(respData).slice(0, 800));
          break;
        }
        // backoff
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    // try next body shape
  }

  return "⚠️ AI 目前無回應（多次嘗試失敗）。請稍後再試或檢查 AI 設定。";
}

// Vision helper (Google Vision API)
async function analyzeImageWithVision(base64Image) {
  if (!GOOGLE_AI_API_KEY) return { error: "GOOGLE_AI_API_KEY 未設定" };
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
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
    return res.data;
  } catch (err) {
    console.error("Vision API error:", err.response?.status, err.response?.data || err.message);
    return { error: err.response?.data || err.message };
  }
}

// Reply to LINE
async function replyToLine(replyToken, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("replyToLine: missing LINE_CHANNEL_ACCESS_TOKEN");
    return;
  }
  const url = "https://api.line.me/v2/bot/message/reply";
  try {
    await axios.post(
      url,
      { replyToken, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
  } catch (err) {
    console.error("replyToLine error:", err.response?.status, err.response?.data || err.message);
  }
}

// -------------------- Signature middleware & webhook --------------------

// verify LINE signature using rawBody
function verifyLineSignature(req, res, next) {
  try {
    const signature = req.get("x-line-signature") || "";
    if (!signature) {
      console.warn("verifyLineSignature: missing x-line-signature header");
      return res.status(401).send("Missing signature");
    }
    if (!req.rawBody) {
      console.warn("verifyLineSignature: missing rawBody");
      return res.status(500).send("Server error");
    }
    if (!LINE_CHANNEL_SECRET) {
      console.warn("verifyLineSignature: LINE_CHANNEL_SECRET not set, skipping verification (INSECURE).");
      // you might want to reject instead; for now continue only for dev convenience
      return next();
    }
    const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(req.rawBody).digest("base64");
    if (hash !== signature) {
      console.warn("verifyLineSignature: invalid signature");
      return res.status(401).send("Invalid signature");
    }
    next();
  } catch (e) {
    console.error("verifyLineSignature error:", e);
    return res.status(500).send("Server error");
  }
}

// Single webhook route (respond quickly to LINE then process events)
app.post("/webhook", verifyLineSignature, async (req, res) => {
  // ACK immediately
  res.status(200).send("OK");

  const events = req.body?.events || [];
  for (const event of events) {
    (async () => {
      try {
        const replyToken = event.replyToken;
        if (!replyToken) return; // skip non-replyable events

        if (event.type !== "message") {
          // expand support here (follow, join, postback, etc.)
          return;
        }

        const message = event.message;
        if (!message) return;

        if (message.type === "text") {
          const userText = message.text || "";
          const answer = await askGoogleAI(userText, systemPrompt);
          await replyToLine(replyToken, String(answer).substring(0, 2000));
        } else if (message.type === "image") {
          const messageId = message.id;
          const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
          try {
            const imgRes = await axios.get(contentUrl, {
              responseType: "arraybuffer",
              headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
              timeout: 15000,
            });
            const imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
            const visionRes = await analyzeImageWithVision(imgBase64);
            if (visionRes.error) {
              await replyToLine(replyToken, "圖片辨識失敗（Vision API）。請查看 logs。");
              return;
            }
            const textAnnotations =
              visionRes.responses?.[0]?.textAnnotations?.[0]?.description || visionRes.responses?.[0]?.fullTextAnnotation?.text || "";
            const labels = (visionRes.responses?.[0]?.labelAnnotations || []).map((l) => `${l.description}(${Math.round(l.score * 100)}%)`).join(", ");
            const prompt = `我收到一張 K 線 / 指標截圖（PoC）。\nOCR_text:\n${textAnnotations || "(無)"}\nLabels: ${labels || "(無)"}\n\n請依獵影策略簡短判斷（PoC）。`;
            const answer = await askGoogleAI(prompt, systemPrompt);
            const replyText = `PoC 圖片分析結果（OCR + Vision labels）：\n\nOCR 摘要: ${textAnnotations ? textAnnotations.substring(0, 800) : "(無)"}\nLabels: ${labels || "(無)"}\n\nAI 判斷（PoC）：\n${String(answer).substring(0, 1500)}`;
            await replyToLine(replyToken, replyText);
          } catch (err) {
            console.error("Failed to download/process image:", err.response?.status, err.response?.data || err.message);
            await replyToLine(replyToken, "圖片下載或處理失敗，請稍後再試。");
          }
        } else {
          await replyToLine(replyToken, "目前只支援文字或圖片（PoC），其他類型暫不支援。");
        }
      } catch (err) {
        console.error("Error processing LINE event:", err.response?.data || err.message || err);
      }
    })();
  }
});

// Start
app.listen(PORT, () => {
  console.log(`LINE Bot webhook listening on port ${PORT}`);
});
