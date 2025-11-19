/**
 * index.js - LINE webhook + Google Generative API (gemini-2.5-flash) PoC
 *
 * - Reads env vars:
 *   - PORT (default 10000)
 *   - LINE_CHANNEL_ACCESS_TOKEN
 *   - LINE_CHANNEL_SECRET
 *   - GOOGLE_BEARER_TOKEN (preferred) OR GOOGLE_API_KEY (fallback; less secure)
 *   - GOOGLE_AI_MODEL (default "gemini-2.5-flash")
 *
 * - Behavior:
 *   - Quick 200 ACK for incoming LINE webhook.
 *   - Process message asynchronously (simple in-process queue for PoC).
 *   - Calls Google Generative API via POST to:
 *       https://generativelanguage.googleapis.com/v1beta/models/{model}:generateMessage
 *     with Authorization: Bearer <token> if GOOGLE_BEARER_TOKEN is present.
 *
 * - Features:
 *   - Basic retry with exponential backoff.
 *   - Defensive error handling and clear logs.
 *
 * NOTE:
 * - For production, replace in-process queue with Redis/Bull and use service-account OAuth flow.
 * - Put all secrets in Render environment variables (do NOT embed in code).
 */

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 10000;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";
const GOOGLE_BEARER_TOKEN = process.env.GOOGLE_BEARER_TOKEN || "";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || ""; // fallback (less secure)
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.warn("警告: LINE tokens 未設定。請把 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_CHANNEL_SECRET 設成 Render secrets。");
}

if (!GOOGLE_BEARER_TOKEN && !GOOGLE_API_KEY) {
  console.warn("警告: Google API token 未設定。請設定 GOOGLE_BEARER_TOKEN（優先）或 GOOGLE_API_KEY（備用）。");
}

const app = express();
app.use(bodyParser.json());

// Simple in-memory queue for PoC (bounded)
const taskQueue = [];
let workerRunning = false;
const MAX_QUEUE = 200;

/** push a task to queue and ensure worker is running */
function enqueueTask(task) {
  if (taskQueue.length >= MAX_QUEUE) {
    console.error("Queue full - dropping task");
    return false;
  }
  taskQueue.push(task);
  if (!workerRunning) runWorker();
  return true;
}

/** simple worker loop */
async function runWorker() {
  workerRunning = true;
  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    try {
      await processLineEvent(task.event);
    } catch (err) {
      console.error("Worker failed processing event:", err?.message || err);
    }
    // small pause to avoid tight loop
    await new Promise((r) => setTimeout(r, 50));
  }
  workerRunning = false;
}

/** LINE reply helper */
async function replyToLine(replyToken, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return;
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error("Failed to reply to LINE:", err?.response?.data || err.message);
  }
}

/** call Google Generative API with retries */
async function askGoogleAI(promptText) {
  const model = GOOGLE_AI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateMessage${(!GOOGLE_BEARER_TOKEN && GOOGLE_API_KEY) ? `?key=${encodeURIComponent(GOOGLE_API_KEY)}` : ""}`;

  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: promptText,
          },
        ],
      },
    ],
    // tunables — adjust as needed
    temperature: 0.2,
    // maxOutputTokens: 1024 // optional
  };

  const headers = {
    "Content-Type": "application/json",
  };
  if (GOOGLE_BEARER_TOKEN) {
    headers["Authorization"] = `Bearer ${GOOGLE_BEARER_TOKEN}`;
  }

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const res = await axios.post(url, body, {
        headers,
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 500, // handle 4xx manually
      });

      if (res.status >= 200 && res.status < 300) {
        // Google response shape may vary; try to extract text safely
        // Typical successful response will contain `candidates` or `output` or `message`
        // We make a best-effort extraction:
        const data = res.data || {};
        // attempt several common places:
        let text = null;
        if (data.output && data.output[0] && data.output[0].content) {
          // older variant
          try {
            text = data.output.map((o) => {
              if (o.content && Array.isArray(o.content)) {
                return o.content.map((c) => c.text || "").join("");
              }
              return "";
            }).join("\n");
          } catch (e) { /* noop */ }
        }
        if (!text && data.candidates && data.candidates[0] && data.candidates[0].content) {
          try {
            text = data.candidates.map((c) => c.content.map(p => p.text || "").join("")).join("\n");
          } catch (e) {}
        }
        if (!text && data.message && data.message.content) {
          try {
            text = data.message.content.map(c => c.text || "").join("");
          } catch (e) {}
        }
        // fallback: stringify whole response (safe truncation)
        if (!text) text = JSON.stringify(data).slice(0, 4000);

        return { ok: true, text };
      } else {
        // 4xx/5xx handling
        console.warn(`Google API returned status ${res.status}`, res.data?.error || res.data);
        // for 4xx (bad request), don't retry forever; for 429/5xx, do backoff
        if (res.status >= 500 || res.status === 429) {
          const backoff = Math.pow(2, attempt) * 200;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        } else {
          return { ok: false, error: res.data || `status ${res.status}` };
        }
      }
    } catch (err) {
      console.error("askGoogleAI attempt error:", err?.message || err);
      // network error or timeout, backoff and retry
      const backoff = Math.pow(2, attempt) * 200;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return { ok: false, error: "max retries reached" };
}

/** process one LINE event */
async function processLineEvent(event) {
  if (!event) return;
  try {
    // Only handle message events in this PoC (text)
    if (event.type === "message" && event.message && event.message.type === "text") {
      const userText = event.message.text;
      console.log("Processing user text:", userText?.slice(0, 200));
      // call Google AI
      const prompt = userText;
      const aiRes = await askGoogleAI(prompt);
      if (aiRes.ok) {
        // reply to user (push or reply)
        if (event.replyToken) {
          await replyToLine(event.replyToken, [{ type: "text", text: aiRes.text }]);
        } else if (event.source && event.source.userId) {
          // fallback: push (requires channel to have push permission)
          try {
            await axios.post(
              `https://api.line.me/v2/bot/message/push`,
              { to: event.source.userId, messages: [{ type: "text", text: aiRes.text }] },
              { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
            );
          } catch (err) {
            console.error("Push failed:", err?.response?.data || err.message);
          }
        }
      } else {
        console.error("AI failed:", aiRes.error);
        if (event.replyToken) {
          await replyToLine(event.replyToken, [{ type: "text", text: "抱歉，系統暫時無法回覆（AI 呼叫失敗）。" }]);
        }
      }
    } else {
      // Not handled event types — ack quietly
      if (event.replyToken) {
        await replyToLine(event.replyToken, [{ type: "text", text: "收到非文字訊息／未支援的事件。我現在只支援文字聊天。" }]);
      }
    }
  } catch (err) {
    console.error("processLineEvent error:", err?.response?.data || err?.message || err);
    if (event.replyToken) {
      await replyToLine(event.replyToken, [{ type: "text", text: "系統錯誤，請稍後再試。" }]);
    }
  }
}

/** webhook endpoint */
app.post("/webhook", (req, res) => {
  try {
    const body = req.body || {};
    // Quick ACK to satisfy LINE webhook timing requirements
    res.status(200).send("ok");

    // queue events for asynchronous processing
    const events = Array.isArray(body.events) ? body.events : [];
    for (const ev of events) {
      const ok = enqueueTask({ event: ev });
      if (!ok) {
        console.warn("Failed to enqueue event (queue full)");
      }
    }
  } catch (err) {
    console.error("webhook handler error:", err);
    // still respond 200 to avoid retries flooding
    res.status(200).send("ok");
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", queue: taskQueue.length, workerRunning });
});

// start
app.listen(PORT, () => {
  console.log(`LINE Bot webhook listening on port ${PORT}`);
  console.log(`Using Google model ${GOOGLE_AI_MODEL}. Provide GOOGLE_BEARER_TOKEN in env for Authorization.`);
});
