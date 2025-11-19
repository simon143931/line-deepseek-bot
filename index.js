// index.js
// LINE Bot + Google Generative AI (robust, safe, production-ready PoC)
// Node >= 18+, ESM style

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Health ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: {
      model: process.env.GOOGLE_AI_MODEL ? "set" : "default",
      hasLineToken: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      hasGoogleKey: !!process.env.GOOGLE_AI_API_KEY,
    },
  });
});

// --- Env + Safe logs ---
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash"; // default safe
const PORT = process.env.PORT || 3000;

function redact(k){
  if(!k) return "(empty)";
  return k.slice(0,4) + "..." + k.slice(-4);
}
console.log(`Starting bot (model=${GOOGLE_AI_MODEL}) keys: LINE=${redact(LINE_CHANNEL_ACCESS_TOKEN)} GOOGLE=${redact(GOOGLE_AI_API_KEY)}`);

// --- Simple per-user rate limiter (in-memory, PoC) ---
const RATE_LIMIT_WINDOW_MS = 10_000; // 10s
const RATE_LIMIT_MAX = 5; // max requests per window per user
const rateMap = new Map();
function isRateLimited(userId){
  if(!userId) return false;
  const now = Date.now();
  const entry = rateMap.get(userId) || { ts: now, count: 0 };
  if(now - entry.ts > RATE_LIMIT_WINDOW_MS){
    entry.ts = now;
    entry.count = 1;
    rateMap.set(userId, entry);
    return false;
  }
  entry.count++;
  rateMap.set(userId, entry);
  return entry.count > RATE_LIMIT_MAX;
}

// --- LINE signature verification middleware ---
function verifyLineSignature(req, res, next){
  try{
    const signature = req.get("x-line-signature") || "";
    if(!LINE_CHANNEL_SECRET){
      // if secret not set, skip verification but warn
      console.warn("LINE_CHANNEL_SECRET not set — skipping signature verification");
      return next();
    }
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(body).digest("base64");
    if(hash !== signature){
      console.warn("Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }
    return next();
  }catch(e){
    console.error("Signature verify error", e.message);
    return res.status(400).send("Bad request");
  }
}

// --- Helper: reply to LINE ---
async function replyToLine(replyToken, messages){
  const url = "https://api.line.me/v2/bot/message/reply";
  try{
    const body = { replyToken, messages: Array.isArray(messages) ? messages : [{ type: "text", text: String(messages) }] };
    await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
  }catch(err){
    console.error("replyToLine error:", err?.response?.status, (err?.response?.data && JSON.stringify(err.response.data).slice(0,400)) || err.message);
  }
}

// --- Google AI request helper (robust, safe logging, retry, alt body shapes) ---
async function askGoogleAI(userText, systemPrompt = ""){
  if(!GOOGLE_AI_API_KEY){
    console.error("Missing GOOGLE_AI_API_KEY");
    return "⚠️ 系統錯誤：AI 金鑰未設定，請聯絡管理員。";
  }

  const model = GOOGLE_AI_MODEL;
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // Determine whether KEY is OAuth-like (starting with ya29) -> Bearer else ?key
  const isOAuthLike = /^ya29(\.|-)/.test(GOOGLE_AI_API_KEY) || GOOGLE_AI_API_KEY.startsWith("ya29");
  const headers = { "Content-Type": "application/json" };
  if(isOAuthLike) headers["Authorization"] = `Bearer ${GOOGLE_AI_API_KEY}`;
  const url = isOAuthLike ? baseUrl : `${baseUrl}?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  // Prepare alternative body shapes to increase compatibility
  const bodies = [
    // canonical "contents"
    { contents: [{ role: "user", parts: [{ text: (systemPrompt||"") + "\n\n" + (userText||"") }] }] },
    // chat-style
    { messages: [{ role: "system", content: [{ text: systemPrompt||"" }] }, { role: "user", content: [{ text: userText||"" }] }] },
    // minimal input
    { input: (systemPrompt||"") + "\n\n" + (userText||"") }
  ];

  const maxBodyRetries = 2;
  for(let i=0;i<bodies.length;i++){
    let body = bodies[i];
    for(let attempt=0;attempt<=maxBodyRetries;attempt++){
      try{
        const res = await axios.post(url, body, { headers, timeout: 20000 });
        const data = res.data || {};
        // normalize candidate extraction across possible shapes
        const candidate =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          data?.candidates?.[0]?.content?.text ||
          data?.output?.[0]?.content?.text ||
          data?.outputs?.[0]?.candidates?.[0]?.content?.parts?.[0]?.text ||
          (Array.isArray(data?.responses) && data.responses[0]?.items?.map?.(i => i.text).join("\n")) ||
          data?.text ||
          null;

        if(candidate) return String(candidate);

        // if success but nothing, return truncated JSON (safe)
        console.warn("Google returned success but no text candidate, keys:", Object.keys(data));
        return JSON.stringify(data).slice(0,1500);
      }catch(err){
        const status = err?.response?.status;
        const resp = err?.response?.data;
        // handle 400 by truncating userText if it's large
        if(status === 400 && (userText || "").length > 500){
          userText = userText.slice(0,400);
          if(body.contents) body.contents[0].parts[0].text = (systemPrompt||"") + "\n\n" + userText;
          continue;
        }
        // 404 likely model name wrong: log and continue to next body shape
        if(status === 404){
          console.error(`Google API 404 for model=${model} (attempt bodyIdx=${i}).`);
          break; // move to next body shape faster
        }
        // network/other -> retry with backoff
        if(attempt >= maxBodyRetries){
          console.error(`askGoogleAI failed (bodyIdx=${i}) status=${status} msg=${err.message}`);
          if(resp) console.error("resp snippet:", JSON.stringify(resp).slice(0,1000));
          break;
        }
        await new Promise(r => setTimeout(r, 300 * (attempt+1)));
      }
    }
  }
  return "⚠️ AI 目前無回應（多次嘗試失敗）。請稍後再試或檢查設定。";
}

// --- Vision OCR (Google Vision API) ---
async function analyzeImageWithVision(base64Image){
  if(!GOOGLE_AI_API_KEY) return { error: "GOOGLE_AI_API_KEY 未設定" };
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;
  const body = {
    requests: [{
      image: { content: base64Image },
      features: [
        { type: "TEXT_DETECTION", maxResults: 1 },
        { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
        { type: "LABEL_DETECTION", maxResults: 5 }
      ]
    }]
  };
  try{
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
    return res.data;
  }catch(err){
    console.error("Vision API error:", err?.response?.status, (err?.response?.data && JSON.stringify(err.response.data).slice(0,500)) || err.message);
    return { error: err?.response?.data || err.message };
  }
}

// --- webhook: main handler ---
app.post("/webhook", verifyLineSignature, async (req, res) => {
  // respond 200 quickly to avoid LINE retries; handle events async
  res.status(200).send("OK");

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for(const ev of events){
    (async () => {
      try{
        // basic filter
        if(ev.type !== "message") return;
        const replyToken = ev.replyToken;
        const userId = ev?.source?.userId || ev?.source?.groupId || "unknown";

        if(isRateLimited(userId)){
          await replyToLine(replyToken, { type: "text", text: "系統忙碌或發送過於頻繁，請稍後再試。" });
          return;
        }

        const msg = ev.message;
        if(!msg) return;

        if(msg.type === "text"){
          const userText = String(msg.text || "").trim();
          if(!userText){
            await replyToLine(replyToken, "收到空白訊息，請再輸入文字或圖片。");
            return;
          }

          // prepend system prompt to each call to keep agent behavior consistent
          const answer = await askGoogleAI(userText, systemPrompt);
          // guard length: LINE text max ~2000; send as chunks if longer
          const MAX = 1800;
          for(let i=0;i<answer.length;i+=MAX){
            await replyToLine(replyToken, { type: "text", text: answer.slice(i, i+MAX) });
          }
        } else if(msg.type === "image"){
          // download image from LINE content API
          const messageId = msg.id;
          const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
          let imgBase64 = null;
          try{
            const imgRes = await axios.get(contentUrl, {
              responseType: "arraybuffer",
              headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
              timeout: 20000
            });
            imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
          }catch(err){
            console.error("download image error:", err?.response?.status, err?.message);
            await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
            return;
          }

          const vision = await analyzeImageWithVision(imgBase64);
          if(vision.error){
            await replyToLine(replyToken, "圖片辨識失敗（Vision API）。請查看 logs。");
            return;
          }

          const textAnnotations = vision.responses?.[0]?.textAnnotations?.[0]?.description || vision.responses?.[0]?.fullTextAnnotation?.text || "";
          const labelsArr = vision.responses?.[0]?.labelAnnotations || [];
          const labels = labelsArr.map(l => `${l.description}(${Math.round((l.score||0)*100)}%)`).join(", ");

          const prompt = `我收到一張 K 線 / 指標截圖（PoC）。\nOCR_text:\n${textAnnotations || "(無)"}\nLabels: ${labels || "(無)"}\n\n請依獵影策略簡短判斷（PoC）。`;
          const answer = await askGoogleAI(prompt, systemPrompt);

          const replyText = [
            "PoC 圖片分析結果（OCR + Vision labels）：",
            "",
            "OCR 摘要:",
            textAnnotations ? textAnnotations.substring(0,800) : "(無)",
            "",
            "Labels:",
            labels || "(無)",
            "",
            "AI 判斷（PoC）:",
            answer.substring(0,1500)
          ].join("\n");

          // chunk if necessary
          const MAX = 1800;
          for(let i=0;i<replyText.length;i+=MAX){
            await replyToLine(replyToken, { type: "text", text: replyText.slice(i,i+MAX) });
          }
        } else {
          await replyToLine(replyToken, "目前只支援文字或圖片（PoC），其他類型暫不支援。");
        }
      }catch(e){
        console.error("Error processing event:", (e?.response?.data && JSON.stringify(e.response.data).slice(0,500)) || e.message || e);
      }
    })();
  }
});

// --- start ---
app.listen(PORT, () => {
  console.log(`LINE Bot webhook listening on port ${PORT}`);
});
