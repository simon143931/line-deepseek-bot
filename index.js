import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";

dotenv.config();

const app = express();

// Capture RAW body for LINE signature validation
app.use(
  express.json({
    limit: "5mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Health check ---
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// --- ENV VARIABLES ---
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GOOGLE_AI_MODEL =
  process.env.GOOGLE_AI_MODEL || "gemini-1.5-flash";

if (!LINE_CHANNEL_ACCESS_TOKEN)
  console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
if (!LINE_CHANNEL_SECRET)
  console.warn("⚠️ LINE_CHANNEL_SECRET 未設定（LINE 簽章驗證必需）");
if (!GOOGLE_AI_API_KEY)
  console.warn("⚠️ GOOGLE_AI_API_KEY 未設定");

// --- LOAD SYSTEM PROMPT ---
let systemPrompt = "";
try {
  systemPrompt = fs.readFileSync("./prompt.txt", "utf8");
  console.log("✅ 已讀取 prompt.txt");
} catch (err) {
  console.error("❌ 讀取 prompt.txt 失敗：", err);
}

// --- LINE SIGNATURE VERIFICATION ---
function verifyLineSignature(req, res, next) {
  try {
    const signature = req.get("x-line-signature");
    if (!signature) return res.status(401).send("Missing signature");

    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(req.rawBody)
      .digest("base64");

    if (hash !== signature) {
      console.warn("❌ LINE Signature 驗證失敗");
      return res.status(401).send("Invalid signature");
    }

    next();
  } catch (err) {
    console.error("Signature verify error:", err);
    return res.status(500).send("Server error");
  }
}

// --- CALL GOOGLE GEMINI ---
// ↑ 已優化：容錯、fallback、多格式嘗試
async function askGoogleAI(userText, sysPrompt = "") {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GOOGLE_AI_MODEL +
    ":generateContent?key=" +
    GOOGLE_AI_API_KEY;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: (sysPrompt || "") + "\n\n" + (userText || ""),
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

    const text =
      res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    return text || "（模型沒有回覆內容）";
  } catch (err) {
    console.error(
      "Google API error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return "⚠️ AI 繁忙或錯誤，請稍後再試。";
  }
}

// --- GOOGLE VISION FOR IMAGES ---
async function analyzeImage(base64Data) {
  const url =
    "https://vision.googleapis.com/v1/images:annotate?key=" +
    GOOGLE_AI_API_KEY;

  const body = {
    requests: [
      {
        image: { content: base64Data },
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
    console.error(
      "Vision API error:",
      err.response?.status,
      err.response?.data || err.message
    );
    return { error: "Vision API error" };
  }
}

// --- REPLY TO LINE ---
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
            text,
          },
        ],
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
      "Reply error:",
      err.response?.status,
      err.response?.data || err.message
    );
  }
}

// --- MAIN WEBHOOK ---
app.post("/webhook", verifyLineSignature, async (req, res) => {
  res.status(200).send("OK"); // respond to LINE immediately

  const events = req.body.events || [];

  for (const event of events) {
    (async () => {
      try {
        if (event.type !== "message") return;

        const replyToken = event.replyToken;
        const msg = event.message;

        // --- TEXT ---
        if (msg.type === "text") {
          const userText = msg.text;
          const answer = await askGoogleAI(userText, systemPrompt);
          await replyToLine(replyToken, answer.substring(0, 2000));
        }

        // --- IMAGE ---
        else if (msg.type === "image") {
          const messageId = msg.id;
          const imgUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

          let base64img = null;

          try {
            const imgRes = await axios.get(imgUrl, {
              responseType: "arraybuffer",
              headers: {
                Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
              },
            });

            base64img = Buffer.from(imgRes.data).toString("base64");
          } catch (err) {
            console.error("Image download failed:", err.message);
            await replyToLine(replyToken, "⚠️ LINE 圖片下載失敗");
            return;
          }

          const vision = await analyzeImage(base64img);

          if (vision.error) {
            await replyToLine(replyToken, "⚠️ 圖片辨識失敗");
            return;
          }

          const text =
            vision.responses?.[0]?.fullTextAnnotation?.text ||
            vision.responses?.[0]?.textAnnotations?.[0]?.description ||
            "";

          const labels =
            vision.responses?.[0]?.labelAnnotations
              ?.map(
                (l) =>
                  `${l.description} (${Math.round(l.score * 100)}%)`
              )
              .join(", ") || "(無)";

          const prompt = `
我收到一張 K 線圖片：
OCR 文字：
${text}

辨識標籤：
${labels}

請依《獵影策略》進行判斷與建議。
          `;

          const answer = await askGoogleAI(prompt, systemPrompt);

          await replyToLine(
            replyToken,
            answer.substring(0, 1500)
          );
        }
      } catch (err) {
        console.error("Event processing error:", err.message);
      }
    })();
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 LINE Bot running on port " + PORT)
);
