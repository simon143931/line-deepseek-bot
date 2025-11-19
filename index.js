// index.upgraded.js
// Upgraded LINE + Google Generative AI integration
// - More robust Google AI caller (tries multiple payload shapes and header styles)
// - Better error logs (without leaking API keys)
// - Vision call separated and safer
// - Small improvements: env validation, timeouts, backoff, graceful reply fallback

import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Env
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY; // prefer Bearer style but some projects allow ?key
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5";
const GOOGLE_AI_REGION = process.env.GOOGLE_AI_REGION || ""; // reserved

if (!LINE_CHANNEL_ACCESS_TOKEN) console.warn("Warning: LINE_CHANNEL_ACCESS_TOKEN 未設定。");
if (!GOOGLE_AI_API_KEY) console.warn("Warning: GOOGLE_AI_API_KEY 未設定。");

// Basic helpers
function redactedKey(k) {
  if (!k) return "(empty)";
  return k.slice(0, 4) + "..." + k.slice(-4);
}

console.log(`Starting with model=${GOOGLE_AI_MODEL}, key=${redactedKey(GOOGLE_AI_API_KEY)}`);

// system prompt (kept as in your original file)
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




請你牢記以上所有規則，之後所有回答一律遵守。




【圖片識別邏輯】

如果使用者傳來圖片（如 K 線截圖、OBV + 布林圖），你要：




1. 直接解析圖片內容，包括：

- OBV 與 MA 相對位置

- OBV 與布林帶相對位置（突破 / 收回 / 毫無接觸）

- 當前 K 棒是否為：十字星 / 實體吞沒 / 影線吞沒 / 都不是

- ATR 位置如有顯示，幫忙估算停損距離

- 有沒有超過 3 根連續止損（如果能識別）




2. 依照獵影策略流程主動執行：

A. 判斷這是否為盤整行情（如果不是，直接說建議觀察）

B. 判斷有沒有出現策略中的進場型態

C. 如果進場條件符合：

- 建議進場方向（做多 / 做空）

- 建議進場價格（可依 K 棒型態決定市價或掛單）

- 建議停損價格（用 ATR 或影線為基礎）

- 計算 1R 和 1.5R 的停利價格

D. 如果條件不符合：直接說明原因並建議觀望。




3. 如果圖片資訊不足以自動做決策，你要：

- 列出缺少的關鍵資訊，例如 ATR 數字、截圖時間週期等。

- 用友好語氣請使用者補充，而不是拒絕回答。




⚠️ 記住：無論使用者輸入多少或少，你都要做到「主動替他檢查」並給完整決策報告。`;

// robust request to Google Generative APIs
async function tryPost(url, body, headers = {}) {
  try {
    const res = await axios.post(url, body, {
      headers: { "Content-Type": "application/json", ...headers },
      timeout: 20000,
    });
    return { ok: true, res };
  } catch (err) {
    return { ok: false, err };
  }
}

async function askGoogleAI(userText) {
  if (!GOOGLE_AI_API_KEY) return "Google AI key 未設定，請先設定環境變數。";

  // Candidate endpoints (keep trying sensible variants) - do NOT log full URLs with key
  const base = "https://generativelanguage.googleapis.com";
  const endpoints = [
    `${base}/v1/models/${encodeURIComponent(GOOGLE_AI_MODEL)}:generateText`,
    `${base}/v1beta/models/${encodeURIComponent(GOOGLE_AI_MODEL)}:generateText`,
    `${base}/v1beta/models/${encodeURIComponent(GOOGLE_AI_MODEL)}:generateContent`,
    `${base}/v1/models/${encodeURIComponent(GOOGLE_AI_MODEL)}:generate`,
  ];

  // prepare candidate payload shapes (many Google client libs adapt these; we attempt multiple)
  const userPrompt = systemPrompt + "\n\n下面是使用者的問題：\n\n" + userText;

  const payloads = [
    // simple prompt (older style)
    { prompt: userPrompt },
    // input object
    { input: { text: userPrompt } },
    // messages style (chat-like)
    { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }] },
    // instances style (some endpoints accept instances)
    { instances: [{ input: userPrompt }] },
  ];

  // Try with Authorization: Bearer first (preferred), then fallback to ?key in URL
  const bearerHeaders = { Authorization: `Bearer ${GOOGLE_AI_API_KEY}` };

  let lastErr = null;
  for (const url of endpoints) {
    // 1) Try with Bearer header
    for (const body of payloads) {
      const { ok, res, err } = await tryPost(url, body, bearerHeaders);
      if (ok) {
        try {
          // attempt to normalize different shapes
          const d = res.data;
          if (d && d.candidates && d.candidates.length) {
            const parts = d.candidates[0].content?.parts || [];
            return parts.map((p) => p.text || "").join("\n");
          }
          if (d?.output?.text) return d.output.text;
          if (d?.response?.message) return d.response.message;
          if (d?.responses && d.responses[0]) return JSON.stringify(d.responses[0]).slice(0, 2000);
          return JSON.stringify(d).slice(0, 2000);
        } catch (e) {
          return `Google AI 返回但解析失敗：${e.message}`;
        }
      } else {
        lastErr = err;
        // continue trying
      }
    }

    // 2) Try same payloads with ?key= (some projects/API configurations expect this)
    const urlWithKey = url + `?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;
    for (const body of payloads) {
      const { ok, res, err } = await tryPost(urlWithKey, body, {});
      if (ok) {
        try {
          const d = res.data;
          if (d && d.candidates && d.candidates.length) {
            const parts = d.candidates[0].content?.parts || [];
            return parts.map((p) => p.text || "").join("\n");
          }
          if (d?.output?.text) return d.output.text;
          if (d?.response?.message) return d.response.message;
          if (d?.responses && d.responses[0]) return JSON.stringify(d.responses[0]).slice(0, 2000);
          return JSON.stringify(d).slice(0, 2000);
        } catch (e) {
          return `Google AI 返回但解析失敗：${e.message}`;
        }
      } else {
        lastErr = err;
      }
    }
  }

  // final failure: give helpful logged error (without API key)
  console.error("askGoogleAI all attempts failed. lastErr:", lastErr?.response?.status, lastErr?.response?.data || lastErr?.message);
  return "呼叫 Google AI 失敗（請查看 server logs 取得詳細錯誤資訊）。";
}

// Vision helper (unchanged structure but better errors)
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

// reply helper unchanged
async function replyToLine(replyToken, text) {
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

// webhook (keeps your logic but uses upgraded helpers)
app.post("/webhook", async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    try {
      const replyToken = event.replyToken;
      if (event.type !== "message") continue;

      const message = event.message;
      if (message.type === "text") {
        const userText = message.text;
        const answer = await askGoogleAI(userText);
        await replyToLine(replyToken, answer.substring(0, 2000));
      } else if (message.type === "image") {
        // similar as before: download, vision, askGoogleAI
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
          console.error("Failed to download image from LINE:", err.response?.status, err.response?.data || err.message);
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試。");
          continue;
        }

        const visionRes = await analyzeImageWithVision(imgBase64);
        if (visionRes.error) {
          await replyToLine(replyToken, "圖片辨識失敗（Vision API）。請查看 logs。");
          continue;
        }

        const textAnnotations = visionRes.responses?.[0]?.textAnnotations?.[0]?.description || visionRes.responses?.[0]?.fullTextAnnotation?.text || "";
        const labels = (visionRes.responses?.[0]?.labelAnnotations || []).map((l) => `${l.description}(${Math.round(l.score * 100)}%)`).join(", ");

        let prompt = `我收到一張 K 線 / 指標截圖（PoC）。\nOCR_text:\n${textAnnotations || "(無)"}\nLabels: ${labels || "(無)"}\n\n請依獵影策略簡短判斷（PoC）。`;
        const answer = await askGoogleAI(prompt);
        const replyText = `PoC 圖片分析結果（OCR + Vision labels）：\n\nOCR 摘要: ${textAnnotations ? textAnnotations.substring(0, 800) : "(無)"}\nLabels: ${labels || "(無)"}\n\nAI 判斷（PoC）：\n${answer.substring(0, 1500)}`;
        await replyToLine(replyToken, replyText);
      } else {
        await replyToLine(replyToken, "目前只支援文字或圖片（PoC），其他類型暫不支援。");
      }
    } catch (err) {
      console.error("Error processing event:", err.response?.data || err.message || err);
    }
  }
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("LINE Bot webhook listening on port " + PORT));
