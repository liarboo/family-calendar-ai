/**
 * 40_Line.gs — LINE Messaging API
 *
 * 職責：webhook 簽章驗證、回覆訊息。
 * 注意：簽章必須對 Cloudflare Worker 原封轉送的 raw body 計算，
 * Worker 端不可對 body 做任何重新序列化。
 */

/**
 * 驗證 X-Line-Signature（可用 VERIFY_SIGNATURE=false 暫時關閉）。
 * 必須用 byte 陣列計算 HMAC：字串版本遇到中文等多位元組字元時
 * 編碼會與 LINE 的 UTF-8 計算結果不一致，導致驗證永遠失敗。
 */
function verifyLineSignature(body, signature) {
  if (!body || !signature || !CONFIG.LINE_SECRET) return false;
  const hash = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(body, 'application/json').getBytes(),
    Utilities.newBlob(CONFIG.LINE_SECRET, 'text/plain').getBytes()
  );
  return Utilities.base64Encode(hash) === signature;
}

function replyLine(replyToken, message) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.LINE_TOKEN },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: message }]
    }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('LINE reply failed: ' + code + ' ' + res.getContentText());
  }
}

// postback 只能直接執行 kind=create 的方案；其餘（ask_confirmation 等）若也做成按鈕，
// 使用者一按就會走進「請補充」的死路，因此只為可執行方案產生按鈕。
const EXECUTABLE_POSTBACK_KINDS = ['create', 'apply_plan'];

function isExecutablePostbackOption_(option) {
  return !!(option && option.action &&
    EXECUTABLE_POSTBACK_KINDS.indexOf(option.action.kind) !== -1);
}

function replyDecisionOptions(replyToken, message, decisionId, ranked) {
  const actions = [];
  (ranked.ranked || [ranked.best, ranked.secondBest]).slice(0, 3).forEach((option) => {
    if (!isExecutablePostbackOption_(option)) return;
    actions.push({
      type: 'postback',
      label: (option.optionId + '. ' + option.title).slice(0, 20),
      data: 'action=select_decision_option&decisionId=' +
        encodeURIComponent(decisionId) + '&optionId=' + encodeURIComponent(option.optionId),
      displayText: '選 ' + option.optionId
    });
  });
  if (!actions.length) {
    replyLine(replyToken, message);
    return;
  }

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.LINE_TOKEN },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: message.slice(0, 4900)
      }, {
        type: 'template',
        altText: '請選擇 What-if 行事曆方案',
        template: {
          type: 'buttons',
          text: '請選擇要執行的方案。詳細變更與分數請看上一則訊息。',
          actions: actions
        }
      }]
    }),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('LINE decision reply failed: ' + code + ' ' + res.getContentText());
  }
}

/** 錯誤路徑專用：回覆失敗也不再丟錯，避免蓋掉原始錯誤 */
function safeReply(replyToken, message) {
  try { replyLine(replyToken, message); } catch (_) {}
}

/** doPost 統一回應格式 */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
