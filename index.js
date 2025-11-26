// index.js
// 最牛逼版本：LINE Bot + Gemini 文字＆圖片 + 自動紀錄 trades + Dashboard + 盤勢偵測 + 每日推播入口

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== 檔案路徑設定 ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRADES_FILE = path.join(__dirname, "trades.json");
const USERS_FILE = path.join(__dirname, "users.json");

// ====== ENV 設定 ======
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || "";
const GOOGLE_AI_MODEL = process.env.GOOGLE_AI_MODEL || "gemini-2.5-flash";

function redactedKey(k) {
  if (!k) return "(empty)";
  return k.slice(0, 4) + "..." + k.slice(-4);
}

console.log("=== Bot 啟動設定 ===");
console.log("LINE_CHANNEL_ACCESS_TOKEN:", LINE_CHANNEL_ACCESS_TOKEN ? "set" : "missing");
console.log("LINE_CHANNEL_SECRET:", LINE_CHANNEL_SECRET ? "set" : "missing");
console.log("GOOGLE_AI_MODEL:", GOOGLE_AI_MODEL);
console.log("GOOGLE_AI_API_KEY:", redactedKey(GOOGLE_AI_API_KEY));
console.log("===================");

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN 未設定");
}
if (!GOOGLE_AI_API_KEY) {
  console.warn("⚠️ GOOGLE_AI_API_KEY 未設定");
}

// ====== 健康檢查 ======
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ====== trades.json 自動修復 & 讀寫工具 ======
function ensureJsonFile(pathStr, defaultValue) {
  try {
    if (!fs.existsSync(pathStr)) {
      fs.writeFileSync(pathStr, JSON.stringify(defaultValue, null, 2), "utf8");
      return;
    }
    const raw = fs.readFileSync(pathStr, "utf8").trim();
    if (!raw) {
      fs.writeFileSync(pathStr, JSON.stringify(defaultValue, null, 2), "utf8");
      return;
    }
    JSON.parse(raw); // 只為了確認可 parse
  } catch (e) {
    console.error(`${pathStr} 損毀，自動重建：`, e.message);
    fs.writeFileSync(pathStr, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

ensureJsonFile(TRADES_FILE, []);
ensureJsonFile(USERS_FILE, []);

function loadTrades() {
  try {
    const raw = fs.readFileSync(TRADES_FILE, "utf8").trim() || "[]";
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    console.error("trades.json 不是 array，自動重設");
    fs.writeFileSync(TRADES_FILE, "[]", "utf8");
    return [];
  } catch (e) {
    console.error("loadTrades error:", e.message);
    fs.writeFileSync(TRADES_FILE, "[]", "utf8");
    return [];
  }
}

function saveTrades(trades) {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), "utf8");
  } catch (e) {
    console.error("saveTrades error:", e.message);
  }
}

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim() || "[]";
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    fs.writeFileSync(USERS_FILE, "[]", "utf8");
    return [];
  } catch (e) {
    console.error("loadUsers error:", e.message);
    fs.writeFileSync(USERS_FILE, "[]", "utf8");
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.error("saveUsers error:", e.message);
  }
}

function rememberUserId(source) {
  if (!source || !source.userId) return;
  const users = loadUsers();
  if (!users.includes(source.userId)) {
    users.push(source.userId);
    saveUsers(users);
  }
}

// ====== 統計計算（給 Dashboard 用） ======
function computeStats(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      total: 0,
      winCount: 0,
      loseCount: 0,
      winRate: 0,
      avgR: 0,
      totalR: 0,
      maxDrawdown: 0,
      maxConsecutiveLosses: 0,
      last30WinRate: 0,
      equityCurve: [],
      marketStateCounts: { range: 0, trend: 0, unknown: 0 },
    };
  }

  let total = trades.length;
  let winCount = 0;
  let loseCount = 0;
  let totalR = 0;
  let rList = [];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxConsecLoss = 0;
  let curConsecLoss = 0;
  const equityCurve = [];
  const marketStateCounts = { range: 0, trend: 0, unknown: 0 };

  trades.forEach((t, idx) => {
    const r = typeof t.rMultiple === "number" ? t.rMultiple : 0;
    const result = t.result || "";
    const market = t.marketState || "unknown";

    if (result === "win") winCount++;
    if (result === "lose") {
      loseCount++;
      curConsecLoss++;
      if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
    } else if (result === "win") {
      curConsecLoss = 0;
    }

    if (market === "range") marketStateCounts.range++;
    else if (market === "trend") marketStateCounts.trend++;
    else marketStateCounts.unknown++;

    totalR += r;
    rList.push(r);
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    equityCurve.push({
      index: idx + 1,
      equity,
    });
  });

  const winRate = total ? (winCount / total) * 100 : 0;
  const avgR = rList.length ? rList.reduce((a, b) => a + b, 0) / rList.length : 0;

  // 最近 30 筆勝率
  const recent = trades.slice(-30);
  let rWin = 0;
  recent.forEach((t) => {
    if (t.result === "win") rWin++;
  });
  const last30WinRate = recent.length ? (rWin / recent.length) * 100 : 0;

  return {
    total,
    winCount,
    loseCount,
    winRate,
    avgR,
    totalR,
    maxDrawdown,
    maxConsecutiveLosses: maxConsecLoss,
    last30WinRate,
    equityCurve,
    marketStateCounts,
  };
}

// ====== system prompt（獵影策略教練） ======
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

// ====== Gemini 共用 call 函式 ======
async function callGemini(contents) {
  if (!GOOGLE_AI_API_KEY) {
    console.error("GOOGLE_AI_API_KEY 未設定");
    return "⚠️ 系統設定錯誤：GOOGLE_AI_API_KEY 未設定。";
  }

  const model = GOOGLE_AI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GOOGLE_AI_API_KEY)}`;

  try {
    const res = await axios.post(
      url,
      { contents },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );
    const data = res.data || {};
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("\n").trim();
    return text || "（模型沒有回應內容）";
  } catch (err) {
    console.error("Gemini 呼叫失敗：", err.response?.status, err.response?.data || err.message);
    return "⚠️ AI 目前沒有回應，請稍後再試。";
  }
}

// 文字模式：純問答教練
async function askGeminiText(userText) {
  const input = `${systemPrompt}

下面是使用者的問題，請依獵影策略的規則來回答，並清楚提醒「盤整 / 趨勢」、「是否適用獵影策略」、「建議進出場與停損停利」：

使用者：${userText}
`;
  const contents = [
    {
      role: "user",
      parts: [{ text: input }],
    },
  ];
  return await callGemini(contents);
}

// 圖片模式：請 Gemini 直接讀圖，並輸出 JSON + 說明
async function analyzeImageWithGemini(base64Image, mimeType = "image/jpeg") {
  const instruction = `
你是一位獵影策略教練，請讀取這張截圖（含 K 線、OBV、布林帶）。

請你：
1. 判斷現在是「盤整」還是「趨勢」。
2. 判斷是否適用獵影策略。
3. 如果可進場，請依獵影策略規則給出方向、進場價、停損、1R 與 1.5R 停利目標。
4. 估計這筆交易的理論 R 倍數（如果有合理的預期）。
5. 用最多 3 句話說明你如何判斷。

⚠️ 請一定輸出以下 JSON 格式，且「只在一個 \`\`\`json 區塊內給出 JSON」：

\`\`\`json
{
  "market_state": "range 或 trend 或 unknown",
  "strategy_allowed": true 或 false,
  "reason": "簡短中文說明",
  "obv_state": "above_ma / below_ma / around_ma / unknown",
  "bb_state": "touching_band / breaking_band / inside_band / squeeze / expand / unknown",
  "pattern_type": "doji / body_engulf / shadow_engulf / none / unknown",
  "direction": "long / short / none",
  "entry_price": null 或 數字,
  "stop_loss": null 或 數字,
  "take_profit_1R": null 或 數字,
  "take_profit_1_5R": null 或 數字,
  "r_multiple": null 或 數字,
  "trade_result": "win / lose / breakeven / none"
}
\`\`\`

JSON 之外，你可以再用中文補充說明。`;

  const contents = [
    {
      role: "user",
      parts: [
        { text: instruction },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Image,
          },
        },
      ],
    },
  ];

  const raw = await callGemini(contents);
  return parseJsonFromGeminiText(raw);
}

// 從 Gemini 回傳文字中抽出 JSON
function parseJsonFromGeminiText(text) {
  if (!text) return { json: null, raw: "" };
  let jsonStr = "";

  const matchCode = text.match(/```json([\s\S]*?)```/i);
  if (matchCode) {
    jsonStr = matchCode[1].trim();
  } else {
    // 沒有 fenced code 就嘗試整段
    jsonStr = text.trim();
  }

  try {
    const obj = JSON.parse(jsonStr);
    return { json: obj, raw: text };
  } catch (e) {
    console.error("解析 Gemini JSON 失敗：", e.message);
    return { json: null, raw: text };
  }
}

// ====== LINE Reply / Push ======
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
    console.error("replyToLine error:", err.response?.status, err.response?.data || err.message);
  }
}

async function pushToLine(userId, text) {
  const url = "https://api.line.me/v2/bot/message/push";
  try {
    await axios.post(
      url,
      { to: userId, messages: [{ type: "text", text }] },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error("pushToLine error:", err.response?.status, err.response?.data || err.message);
  }
}

// ====== LINE Signature 驗證 ======
function verifyLineSignature(req, res, next) {
  try {
    if (!LINE_CHANNEL_SECRET) {
      console.warn("LINE_CHANNEL_SECRET 未設定，略過簽名驗證（不安全，但開發可用）");
      return next();
    }
    const signature = req.get("x-line-signature") || "";
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac("sha256", LINE_CHANNEL_SECRET).update(body).digest("base64");
    if (hash !== signature) {
      console.error("Invalid LINE signature");
      return res.status(401).send("Invalid signature");
    }
    next();
  } catch (e) {
    console.error("verifyLineSignature error:", e.message);
    next();
  }
}

// ====== LINE Webhook ======
app.post("/webhook", verifyLineSignature, async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    try {
      rememberUserId(event.source);

      if (event.type !== "message") continue;
      const replyToken = event.replyToken;
      const message = event.message;

      if (message.type === "text") {
        const userText = message.text || "";
        const answer = await askGeminiText(userText);
        await replyToLine(replyToken, answer.substring(0, 2000));
      } else if (message.type === "image") {
        // 下載 LINE 圖片
        const messageId = message.id;
        const contentUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
        let imgBase64 = null;
        let mimeType = "image/jpeg";

        try {
          const imgRes = await axios.get(contentUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
            timeout: 15000,
          });
          const contentType = imgRes.headers["content-type"];
          if (typeof contentType === "string" && contentType.startsWith("image/")) {
            mimeType = contentType;
          }
          imgBase64 = Buffer.from(imgRes.data, "binary").toString("base64");
        } catch (err) {
          console.error("下載 LINE 圖片失敗：", err.response?.status, err.response?.data || err.message);
          await replyToLine(replyToken, "圖片下載失敗，請稍後再試一次。");
          continue;
        }

        const { json: analysis, raw: rawText } = await analyzeImageWithGemini(imgBase64, mimeType);

        // 建立 trade 紀錄
        const trades = loadTrades();
        const trade = {
          id: Date.now().toString(),
          ts: new Date().toISOString(),
          source: "image",
          marketState: analysis?.market_state || "unknown",
          strategyAllowed: typeof analysis?.strategy_allowed === "boolean" ? analysis.strategy_allowed : null,
          direction: analysis?.direction || "none",
          entryPrice: typeof analysis?.entry_price === "number" ? analysis.entry_price : null,
          stopLoss: typeof analysis?.stop_loss === "number" ? analysis.stop_loss : null,
          takeProfit1R: typeof analysis?.take_profit_1R === "number" ? analysis.take_profit_1R : null,
          takeProfit1_5R: typeof analysis?.take_profit_1_5R === "number" ? analysis.take_profit_1_5R : null,
          rMultiple: typeof analysis?.r_multiple === "number" ? analysis.r_multiple : null,
          result: analysis?.trade_result || "none",
          obvState: analysis?.obv_state || "unknown",
          bbState: analysis?.bb_state || "unknown",
          patternType: analysis?.pattern_type || "unknown",
          reason: analysis?.reason || "",
        };
        trades.push(trade);
        saveTrades(trades);

        // 給使用者的人類可讀回覆
        const ms =
          trade.marketState === "range"
            ? "盤勢：盤整（策略理論上可用）"
            : trade.marketState === "trend"
            ? "盤勢：強趨勢（策略多半禁用）"
            : "盤勢：無法明確判斷（unknown）";

        const sa =
          trade.strategyAllowed === true
            ? "✅ 根據圖形，獵影策略「可考慮使用」。"
            : trade.strategyAllowed === false
            ? "❌ 根據圖形，建議「暫停獵影策略，先觀望」。"
            : "⚠️ 模型沒有明確標記策略可用 / 禁用。";

        const dir =
          trade.direction === "long"
            ? "方向：做多"
            : trade.direction === "short"
            ? "方向：做空"
            : "方向：暫不建議進場";

        const priceInfo =
          trade.entryPrice && trade.stopLoss
            ? `進場價約：${trade.entryPrice}\n停損約：${trade.stopLoss}\n1R 目標：約：${trade.takeProfit1R ?? "（模型未給）"}\n1.5R 目標：約：${
                trade.takeProfit1_5R ?? "（模型未給）"
              }`
            : "此圖模型無法給出明確的進場價與停損，請以風險控管為優先。";

        const reasonText = trade.reason ? `教練說明：${trade.reason}` : "模型沒有額外說明原因。";

        const replyText = `🧠 獵影教練圖像分析（已記錄到 Dashboard）

${ms}
${sa}
${dir}

${priceInfo}

OBV 狀態：${trade.obvState}
布林狀態：${trade.bbState}
型態判斷：${trade.patternType}

${reasonText}

（註：以上為策略教學用途，非保證獲利）`;

        await replyToLine(replyToken, replyText.substring(0, 2000));
      } else {
        await replyToLine(replyToken, "目前只支援文字與圖片訊息，其他類型暫不支援。");
      }
    } catch (err) {
      console.error("Error processing event:", err.response?.data || err.message || err);
    }
  }

  res.status(200).send("OK");
});

// ====== Dashboard API ======
app.get("/api/trades", (req, res) => {
  const trades = loadTrades();
  res.json({ trades });
});

app.get("/api/stats", (req, res) => {
  const trades = loadTrades();
  const stats = computeStats(trades);
  res.json({ stats, tradesCount: trades.length });
});

// ====== Dashboard 頁面 ======
app.get("/dashboard", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<title>獵影策略 Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0; background: #0f172a; color: #e5e7eb; }
  header { padding: 16px 24px; background: #020617; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; }
  h1 { font-size: 20px; margin: 0; }
  .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; border: 1px solid #4b5563; }
  main { padding: 16px; max-width: 1200px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .card { background: #020617; border-radius: 16px; padding: 16px; border: 1px solid #1f2937; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
  .card h2 { margin: 0 0 8px; font-size: 16px; }
  .value { font-size: 24px; font-weight: 600; }
  .label { font-size: 12px; color: #9ca3af; }
  .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; margin-right: 6px; }
  .pill-green { background: rgba(34,197,94,0.1); color: #bbf7d0; border: 1px solid rgba(34,197,94,0.4); }
  .pill-red { background: rgba(248,113,113,0.1); color: #fecaca; border: 1px solid rgba(248,113,113,0.4); }
  .pill-slate { background: rgba(148,163,184,0.15); color: #e5e7eb; border: 1px solid rgba(148,163,184,0.4); }
  canvas { max-width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #1f2937; text-align: left; }
  th { color: #9ca3af; font-weight: 500; }
  tr:hover { background: rgba(15,23,42,0.8); }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #4b5563; display: inline-block; }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
<header>
  <div>
    <h1>獵影策略 Performance Dashboard</h1>
    <div style="font-size: 12px; color:#9ca3af;margin-top:4px;">來源：你在 LINE 傳的每一張 K 線 / OBV / 布林圖，AI 解析後自動記錄。</div>
  </div>
  <div class="badge" id="marketBadge">載入中...</div>
</header>
<main>
  <div class="grid">
    <div class="card">
      <h2>整體表現</h2>
      <div class="value" id="totalR">0 R</div>
      <div class="label">累積 R 倍數（全部交易）</div>
      <div style="margin-top:8px;">
        <span class="pill pill-green" id="winRate">勝率：--%</span>
        <span class="pill pill-slate" id="avgR">平均 R：--</span>
      </div>
    </div>
    <div class="card">
      <h2>風險狀態</h2>
      <div class="value" id="maxDD">0 R</div>
      <div class="label">最大回撤</div>
      <div style="margin-top:8px;">
        <span class="pill pill-red" id="maxConsecLoss">最大連虧：--</span>
        <span class="pill pill-slate" id="recentWinRate">近 30 筆勝率：--%</span>
      </div>
    </div>
    <div class="card">
      <h2>盤勢統計</h2>
      <div class="value" id="tradeCount">0 筆</div>
      <div class="label">已記錄的圖像分析 / 交易樣本</div>
      <div style="margin-top:8px;">
        <span class="pill pill-green" id="rangeCount">盤整：--</span>
        <span class="pill pill-red" id="trendCount">趨勢：--</span>
        <span class="pill pill-slate" id="unknownCount">未知：--</span>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Equity Curve（R）</h2>
      <canvas id="equityChart"></canvas>
    </div>
    <div class="card">
      <h2>最近 30 筆勝率走勢</h2>
      <canvas id="rollingWinChart"></canvas>
    </div>
  </div>

  <div class="card">
    <h2>近期紀錄（最新 20 筆）</h2>
    <table id="tradesTable">
      <thead>
        <tr>
          <th>#</th>
          <th>時間</th>
          <th>盤勢</th>
          <th>策略</th>
          <th>方向</th>
          <th>R</th>
          <th>結果</th>
          <th>備註</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
</main>

<script>
async function fetchStats() {
  const res = await fetch("/api/stats");
  const data = await res.json();
  return data;
}

function formatTs(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-TW", { hour12: false });
  } catch {
    return ts;
  }
}

function setupNumbers(stats, tradesCount) {
  document.getElementById("totalR").textContent = (stats.totalR || 0).toFixed(2) + " R";
  document.getElementById("winRate").textContent = "勝率：" + (stats.winRate || 0).toFixed(1) + "%";
  document.getElementById("avgR").textContent = "平均 R：" + (stats.avgR || 0).toFixed(2);
  document.getElementById("maxDD").textContent = (stats.maxDrawdown || 0).toFixed(2) + " R";
  document.getElementById("maxConsecLoss").textContent = "最大連虧：" + (stats.maxConsecutiveLosses || 0) + " 筆";
  document.getElementById("recentWinRate").textContent = "近 30 筆勝率：" + (stats.last30WinRate || 0).toFixed(1) + "%";

  document.getElementById("tradeCount").textContent = tradesCount + " 筆";
  document.getElementById("rangeCount").textContent = "盤整：" + (stats.marketStateCounts?.range || 0);
  document.getElementById("trendCount").textContent = "趨勢：" + (stats.marketStateCounts?.trend || 0);
  document.getElementById("unknownCount").textContent = "未知：" + (stats.marketStateCounts?.unknown || 0);

  const badge = document.getElementById("marketBadge");
  if (tradesCount === 0) {
    badge.textContent = "尚無資料，請先在 LINE 傳一張圖";
    return;
  }
  const last = window.__trades && window.__trades[window.__trades.length - 1];
  if (!last) {
    badge.textContent = "尚無資料";
    return;
  }
  if (last.marketState === "range") {
    badge.textContent = "今日偏盤整：獵影策略理論上可用 ✅";
  } else if (last.marketState === "trend") {
    badge.textContent = "今日偏趨勢：獵影策略建議暫停 ❌";
  } else {
    badge.textContent = "盤勢：未知（資料不足）";
  }
}

function setupEquityChart(equityCurve) {
  const ctx = document.getElementById("equityChart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: equityCurve.map(p => p.index),
      datasets: [{
        label: "累積 R",
        data: equityCurve.map(p => p.equity),
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#e5e7eb" } }
      },
      scales: {
        x: { ticks: { color: "#9ca3af" }, grid: { color: "#111827" } },
        y: { ticks: { color: "#9ca3af" }, grid: { color: "#111827" } }
      }
    }
  });
}

function setupRollingWinChart(trades) {
  const points = [];
  let wins = 0;
  let total = 0;
  for (let i = 0; i < trades.length; i++) {
    total++;
    if (trades[i].result === "win") wins++;
    const start = Math.max(0, i - 29);
    const slice = trades.slice(start, i + 1);
    const win = slice.filter(t => t.result === "win").length;
    const wr = slice.length ? (win / slice.length) * 100 : 0;
    points.push({ idx: i + 1, wr });
  }

  const ctx = document.getElementById("rollingWinChart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: points.map(p => p.idx),
      datasets: [{
        label: "近 30 筆勝率（%）",
        data: points.map(p => p.wr),
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#e5e7eb" } }
      },
      scales: {
        x: { ticks: { color: "#9ca3af" }, grid: { color: "#111827" } },
        y: { ticks: { color: "#9ca3af" }, grid: { color: "#111827" } }
      }
    }
  });
}

function setupTable(trades) {
  const tbody = document.querySelector("#tradesTable tbody");
  tbody.innerHTML = "";
  const recent = trades.slice(-20).reverse();
  recent.forEach((t, idx) => {
    const tr = document.createElement("tr");
    const marketText =
      t.marketState === "range" ? "盤整" :
      t.marketState === "trend" ? "趨勢" : "未知";
    const strategyText =
      t.strategyAllowed === true ? "可用" :
      t.strategyAllowed === false ? "禁用" : "未標記";

    const dirText =
      t.direction === "long" ? "多" :
      t.direction === "short" ? "空" :
      "—";

    const r = typeof t.rMultiple === "number" ? t.rMultiple.toFixed(2) : "—";

    const resultText =
      t.result === "win" ? "勝" :
      t.result === "lose" ? "敗" :
      t.result === "breakeven" ? "打平" :
      "—";

    tr.innerHTML = \`
      <td>\${recent.length - idx}</td>
      <td>\${formatTs(t.ts)}</td>
      <td>\${marketText}</td>
      <td>\${strategyText}</td>
      <td>\${dirText}</td>
      <td>\${r}</td>
      <td>\${resultText}</td>
      <td>\${(t.reason || "").slice(0, 40)}</td>
    \`;
    tbody.appendChild(tr);
  });
}

(async function init() {
  try {
    const res = await fetch("/api/trades");
    const d1 = await res.json();
    window.__trades = d1.trades || [];
    const statsRes = await fetch("/api/stats");
    const d2 = await statsRes.json();
    const stats = d2.stats || {};
    const count = d2.tradesCount || window.__trades.length || 0;

    setupNumbers(stats, count);
    setupEquityChart(stats.equityCurve || []);
    setupRollingWinChart(window.__trades || []);
    setupTable(window.__trades || []);
  } catch (e) {
    console.error("Dashboard 載入失敗：", e);
    document.getElementById("marketBadge").textContent = "Dashboard 載入失敗，請稍後重試";
  }
})();
</script>
</body>
</html>`;
  res.send(html);
});

// ====== 每日推播入口（之後可以接 Render cron） ======
app.get("/cron/daily-check", async (req, res) => {
  try {
    const users = loadUsers();
    if (!users.length) {
      return res.json({ ok: false, message: "尚未記錄任何 LINE 使用者。" });
    }
    const userId = users[0]; // 單人使用情境：用第一個即可

    const trades = loadTrades();
    if (!trades.length) {
      await pushToLine(userId, "尚未有任何盤勢紀錄，請先傳一張圖給「獵影教練」。");
      return res.json({ ok: true, message: "no trades; notified" });
    }
    const last = trades[trades.length - 1];
    let msg = "";
    if (last.marketState === "range") {
      msg = "【每日盤勢檢查】\n最近一筆盤勢偏「盤整」，獵影策略理論上可用 ✅\n\n記得依照 OBV + 布林規則與 ATR 做風險控管。";
    } else if (last.marketState === "trend") {
      msg = "【每日盤勢檢查】\n最近一筆盤勢偏「強趨勢」，建議暫停使用獵影策略 ❌\n\n這種盤容易被來回洗，先觀望、等盤整再上。";
    } else {
      msg = "【每日盤勢檢查】\n盤勢：未知（資料不足）\n建議再截一張 OBV + 布林圖給獵影教練分析。";
    }

    await pushToLine(userId, msg);
    res.json({ ok: true, message: "pushed", lastMarketState: last.marketState || "unknown" });
  } catch (e) {
    console.error("/cron/daily-check error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== 啟動 Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("LINE Bot webhook listening on port " + PORT);
});
