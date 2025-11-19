import express from "express";

import axios from "axios";

import dotenv from "dotenv";

dotenv.config();



const app = express();

app.use(express.json());



// Env vars

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;



// ====== 獵影策略 system prompt ======

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



⚠️ 記住：無論使用者輸入多少或少，你都要做到「主動替他檢查」並給完整決策報告。

`;



// LINE Reply API helper

async function replyToLine(replyToken, text) {

  const url = "https://api.line.me/v2/bot/message/reply";



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

    }

  );

}



// Google AI (Gemini) Chat API helper

async function askGoogleAI(userText) {

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_API_KEY}`;



  const body = {

    contents: [

      {

        role: "user",

        parts: [

          {

            text:

              systemPrompt +

              "\n\n下面是使用者的問題，請依照上面的獵影策略規則來回答：" +

              "\n\n" +

              userText,

          },

        ],

      },

    ],

  };



  const res = await axios.post(url, body, {

    headers: {

      "Content-Type": "application/json",

    },

  });



  const candidates = res.data.candidates;

  if (!candidates || !candidates.length) {

    return "Google AI 沒有回應內容，請稍後再試一次。";

  }



  const parts = candidates[0].content.parts;

  if (!parts || !parts.length) {

    return "Google AI 回傳格式異常，請稍後再試一次。";

  }



  // 把所有文字 parts 接起來

  return parts.map((p) => p.text || "").join("\n");

}



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

        await replyToLine(replyToken, answer.substring(0, 1000));

      } else if (message.type === "image") {

        const fallbackText =

          "目前這個 LINE Bot 暫時只支援文字描述。請你用文字簡單說明 OBV、布林帶、K 棒形狀，我再依獵影策略幫你判斷。";

        await replyToLine(replyToken, fallbackText);

      }

    } catch (err) {

      console.error("Error processing event:", err);

    }

  }



  res.status(200).send("OK");

});



const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("LINE Bot webhook listening on port " + PORT);

});-- index.js END --

-- package.json START --

{

  "name": "line-deepseek-bot",

  "version": "1.0.0",

  "main": "index.js",

  "type": "module",

  "scripts": {

    "start": "node index.js"

  },

  "dependencies": {

    "axios": "^1.6.0",

    "express": "^4.18.2",

    "dotenv": "^16.3.1"

  }

}
