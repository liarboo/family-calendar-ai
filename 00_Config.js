/**
 * 00_Config.gs — 全域設定
 *
 * 所有金鑰與環境變數集中在 Script Properties，這裡統一讀取。
 * 其他檔案一律透過 CONFIG / INTENTS / STATUS 取值，不直接碰 PropertiesService。
 */

const CONFIG = (() => {
  const props = PropertiesService.getScriptProperties();
  return {
    // --- 金鑰與外部資源（必填，設定在 Script Properties）---
    LINE_TOKEN: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
    LINE_SECRET: props.getProperty('LINE_CHANNEL_SECRET'),
    GEMINI_API_KEY: props.getProperty('GEMINI_API_KEY'),
    CALENDAR_ID: props.getProperty('GOOGLE_CALENDAR_ID'),

    // --- 可選設定（沒設就用預設值）---
    TIMEZONE: props.getProperty('TIMEZONE') || 'Asia/Taipei',
    LLM_PROVIDER: props.getProperty('LLM_PROVIDER') || 'gemini',   // 'openai' 或 'gemini'
    OPENAI_API_KEY: props.getProperty('OPENAI_API_KEY'),
    OPENAI_MODEL: props.getProperty('OPENAI_MODEL') || 'gpt-5.4-mini',
    GEMINI_MODEL: props.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash',
    VERIFY_SIGNATURE: (props.getProperty('VERIFY_SIGNATURE') || 'true') === 'true',
    LLM_FALLBACK_ENABLED: (props.getProperty('LLM_FALLBACK_ENABLED') || 'true') === 'true',
    REFLEXION_ENABLED: (props.getProperty('REFLEXION_ENABLED') || 'false') === 'true',
    AUTO_MEMORY_ACTIVE: (props.getProperty('AUTO_MEMORY_ACTIVE') || 'false') === 'true',
    MEMORY_LIMIT: Number(props.getProperty('MEMORY_LIMIT') || 3),
    REFLECTION_ON_ERROR: (props.getProperty('REFLECTION_ON_ERROR') || 'true') === 'true',
    REFLECTION_ON_CORRECTION: (props.getProperty('REFLECTION_ON_CORRECTION') || 'true') === 'true',
    REFLECTION_ON_CALENDAR_API_ERROR: (props.getProperty('REFLECTION_ON_CALENDAR_API_ERROR') || 'true') === 'true',
    REFLECTION_ON_JSON_ERROR: (props.getProperty('REFLECTION_ON_JSON_ERROR') || 'true') === 'true',
    PROFILE_MEMORY_ENABLED: (props.getProperty('PROFILE_MEMORY_ENABLED') || 'true') === 'true',
    PROFILE_MEMORY_AUTO_ACTIVE: (props.getProperty('PROFILE_MEMORY_AUTO_ACTIVE') || 'false') === 'true',
    PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE: (props.getProperty('PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE') || 'true') === 'true',
    WHAT_IF_ENABLED: (props.getProperty('WHAT_IF_ENABLED') || 'true') === 'true',
    WHAT_IF_MODEL: props.getProperty('WHAT_IF_MODEL') || 'gpt-5.4-mini',
    DECISION_LOG_ENABLED: (props.getProperty('DECISION_LOG_ENABLED') || 'true') === 'true',
    WEB_RESEARCH_ENABLED: (props.getProperty('WEB_RESEARCH_ENABLED') || 'false') === 'true',
    DECISION_OUTCOME_LEARNING_ENABLED: (props.getProperty('DECISION_OUTCOME_LEARNING_ENABLED') || 'true') === 'true',

    // --- 行為參數（直接改這裡即可）---
    REPLY_ON_NONE: false,            // intent=none（閒聊）時是否回覆
    FEW_SHOT_LIMIT: 5,               // 帶入 prompt 的學習案例數量上限
    CORRECTION_WINDOW_HOURS: 24,     // 「修正最近一筆行程」的有效時間窗
    DEFAULT_REMINDER_MINUTES: 120,   // 行程提醒（建立前 N 分鐘）
    DEFAULT_DURATION_MINUTES: 60,    // 沒講結束時間時的預設長度
    CONFLICT_CHECK: true,            // 建立行程前是否檢查時段衝突
    PENDING_TTL_MINUTES: 15,         // 衝突詢問的等待時限，逾時自動放棄
    QUERY_MAX_EVENTS: 10,            // 查詢結果最多列出幾筆

    // --- 內部使用 ---
    LEARNING_SHEET_ID_KEY: 'LEARNING_SHEET_ID'  // 自動建立試算表後，ID 存回 Properties 的 key
  };
})();

/** Gemini 解析出的意圖種類。新增意圖時：這裡加一項 + Main 的 INTENT_HANDLERS 加一個 handler。 */
const INTENTS = {
  CREATE: 'create',          // 新增行程（已實作，含衝突檢查）
  CORRECTION: 'correction',  // 修正最近一筆行程（已實作）
  QUERY: 'query',            // 查詢行程（已實作）
  RESOLVE: 'resolve',        // 回覆衝突處理方式（已實作，僅在有待處理衝突時出現）
  UPDATE: 'update',          // 修改指定舊行程（Phase 4 骨架）
  DELETE: 'delete',          // 取消行程（Phase 4 骨架）
  NONE: 'none'               // 與行程無關的閒聊
};

/** learning_log 的 status 欄位值。 */
const STATUS = {
  SUCCESS: 'success',     // 成功建立、修正、查詢或解決衝突
  ERROR: 'error',         // 任一環節失敗
  CORRECTED: 'corrected', // 此筆後來被使用者修正（原始那筆會被改成這個狀態）
  PENDING: 'pending',     // 偵測到衝突，等待使用者決定
  RESOLVED: 'resolved',   // 衝突已由使用者決定處理完畢（原 pending 那筆改成這個）
  CANCELLED: 'cancelled', // 使用者放棄建立
  IGNORED: 'ignored',     // 閒聊，未處理
  SKIPPED: 'skipped'      // 意圖明確但功能尚未實作
};
