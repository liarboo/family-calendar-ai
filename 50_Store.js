/**
 * 50_Store.gs — 學習資料層（第一階段資料庫：Google Sheet）
 *
 * 試算表由程式第一次執行時自動建立，包含兩張表：
 *
 *   log      — 每一次互動的完整紀錄（原句、解析結果、最終結果、狀態、關聯）
 *              這是 AI 學習的原始資料，也是除錯的第一現場。
 *
 *   examples — few-shot 學習案例。每次「使用者修正」會自動產生一筆候選
 *              （enabled=false）；家人在 Sheet 勾選 enabled 後，
 *              下次解析就會帶進 Gemini prompt。
 *              這就是「人類回饋 → 審核 → 進入 prompt loop」的最小閉環。
 */

const LOG_SHEET = 'log';
const EXAMPLE_SHEET = 'examples';
const REFLECTION_SHEET = 'reflection_memory';
const PROFILE_MEMORY_SHEET = 'profile_memory';
const DECISION_LOG_SHEET = 'decision_log';
const FAMILY_PROFILE_SHEET = 'family_profile';
const ROUTINE_MODEL_SHEET = 'routine_model';

const LOG_HEADERS = [
  'logId', 'timestamp', 'groupId', 'userId', 'rawText',
  'intent', 'geminiJson', 'finalJson', 'status',
  'errorMessage', 'calendarEventId', 'relatedLogId'
];
const EXAMPLE_HEADERS = ['enabled', 'rawText', 'expectedJson', 'note', 'createdAt'];
const REFLECTION_HEADERS = [
  'memoryId', 'createdAt', 'groupId', 'sourceLogId', 'triggerType', 'rawText',
  'trajectoryJson', 'evaluatorResult', 'reflectionText', 'memoryStatus',
  'usedCount', 'lastUsedAt', 'note'
];
const PROFILE_MEMORY_HEADERS = [
  'memory_id', 'group_id', 'subject_id', 'memory_type', 'canonical_value',
  'variants_json', 'rule_json', 'evidence_log_ids', 'source_type',
  'confidence', 'status', 'created_at', 'updated_at', 'last_used_at'
];
const DECISION_LOG_HEADERS = [
  'decision_id', 'group_id', 'source_log_id', 'requester_user_id',
  'event_draft_json', 'conflicts_json', 'options_json', 'recommended_option_id',
  'selected_option_id', 'final_action_json', 'research_json', 'outcome',
  'feedback', 'reflection_created', 'status', 'created_at', 'updated_at'
];
const FAMILY_PROFILE_HEADERS = [
  'profile_id', 'group_id', 'member_id', 'name', 'aliases_json', 'role',
  'age_years', 'home_location', 'work_location', 'weekday_start', 'weekday_end',
  'requires_adult_companion', 'notes', 'created_at', 'updated_at'
];
const ROUTINE_MODEL_HEADERS = [
  'routine_id', 'group_id', 'title', 'participant_ids_json', 'owner_id',
  'weekday', 'start_time', 'end_time', 'location', 'movable',
  'event_type', 'needs_adult', 'notes', 'created_at', 'updated_at'
];

// 同一次執行內快取，避免重複 openById
let learningSpreadsheetCache_ = null;

// ---------------------------------------------------------------- 初始化

function getLearningSpreadsheet_() {
  if (learningSpreadsheetCache_) return learningSpreadsheetCache_;

  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CONFIG.LEARNING_SHEET_ID_KEY);

  if (id) {
    try {
      learningSpreadsheetCache_ = SpreadsheetApp.openById(id);
      return learningSpreadsheetCache_;
    } catch (e) {
      // ID 失效（試算表被刪除等）→ 往下重建
    }
  }

  const ss = SpreadsheetApp.create('家庭行事曆 learning_log');
  initSheet_(ss, LOG_SHEET, LOG_HEADERS);
  initSheet_(ss, EXAMPLE_SHEET, EXAMPLE_HEADERS);
  initSheet_(ss, REFLECTION_SHEET, REFLECTION_HEADERS);
  initSheet_(ss, PROFILE_MEMORY_SHEET, PROFILE_MEMORY_HEADERS);
  initSheet_(ss, DECISION_LOG_SHEET, DECISION_LOG_HEADERS);
  initSheet_(ss, FAMILY_PROFILE_SHEET, FAMILY_PROFILE_HEADERS);
  initSheet_(ss, ROUTINE_MODEL_SHEET, ROUTINE_MODEL_HEADERS);
  ss.getSheets().forEach((s) => {           // 移除預設空白工作表
    if ([LOG_SHEET, EXAMPLE_SHEET, REFLECTION_SHEET, PROFILE_MEMORY_SHEET, DECISION_LOG_SHEET,
      FAMILY_PROFILE_SHEET, ROUTINE_MODEL_SHEET]
      .indexOf(s.getName()) === -1) ss.deleteSheet(s);
  });
  props.setProperty(CONFIG.LEARNING_SHEET_ID_KEY, ss.getId());

  learningSpreadsheetCache_ = ss;
  return ss;
}

function initSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // 注意：不可在這裡預插整欄核取方塊。insertCheckboxes 會把儲存格值設為 FALSE，
  // 導致 appendRow 誤判「已有內容」而把資料寫到第 201 列。
  // 核取方塊改由 appendExampleCandidate 逐列補上。
  return sheet;
}

function getSheet_(name) {
  const ss = getLearningSpreadsheet_();
  return ss.getSheetByName(name) ||
    initSheet_(ss, name, sheetHeaders_(name));
}

function sheetHeaders_(name) {
  if (name === LOG_SHEET) return LOG_HEADERS;
  if (name === REFLECTION_SHEET) return REFLECTION_HEADERS;
  if (name === PROFILE_MEMORY_SHEET) return PROFILE_MEMORY_HEADERS;
  if (name === DECISION_LOG_SHEET) return DECISION_LOG_HEADERS;
  if (name === FAMILY_PROFILE_SHEET) return FAMILY_PROFILE_HEADERS;
  if (name === ROUTINE_MODEL_SHEET) return ROUTINE_MODEL_HEADERS;
  return EXAMPLE_HEADERS;
}

function safeJsonStringify_(value) {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch (e) {
    return 'null';
  }
}

function safeJsonParse_(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    console.log('JSON parse failed: ' + String(raw).slice(0, 200));
    return fallback;
  }
}

// ---------------------------------------------------------------- log 讀寫

/** 新增一筆互動紀錄。record 的 key 對應 LOG_HEADERS，缺的欄位補空字串。 */
function appendLog(record) {
  record.timestamp = new Date();
  const row = LOG_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  getSheet_(LOG_SHEET).appendRow(row);
}

/** 依 logId 更新某筆紀錄的 status（修正流程用：原始那筆改成 corrected） */
function markLogStatus(logId, status) {
  const sheet = getSheet_(LOG_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return;

  const ids = sheet.getRange(2, 1, count, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === logId) {
      sheet.getRange(i + 2, LOG_HEADERS.indexOf('status') + 1).setValue(status);
      return;
    }
  }
}

/**
 * 找出此群組「最近一筆已建立且仍有效的行程」紀錄，供修正功能使用。
 * 條件：同 groupId、有 calendarEventId、status=success、在時間窗內。
 * 修正紀錄本身也帶 calendarEventId，因此支援連續修正（改完再改）。
 */
function findLastCalendarLog(groupId) {
  const sheet = getSheet_(LOG_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return null;

  const rows = sheet.getRange(2, 1, count, LOG_HEADERS.length).getValues();
  const cutoff = Date.now() - CONFIG.CORRECTION_WINDOW_HOURS * 3600 * 1000;

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = toRecord_(rows[i]);
    if (r.groupId !== groupId) continue;
    if (!r.calendarEventId || r.status !== STATUS.SUCCESS) continue;
    if (new Date(r.timestamp).getTime() < cutoff) return null;  // 最新一筆也太舊 → 視為無
    return r;
  }
  return null;
}

function toRecord_(row) {
  const r = {};
  LOG_HEADERS.forEach((h, i) => { r[h] = row[i]; });
  return r;
}

function toRecordWithHeaders_(row, headers) {
  const r = {};
  headers.forEach((h, i) => { r[h] = row[i]; });
  return r;
}

// ---------------------------------------------------------------- 學習案例

/** 讀取人工勾選 enabled 的案例，取最新 N 筆，格式化成 prompt 片段 */
function loadFewShotExamples() {
  const sheet = getSheet_(EXAMPLE_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];

  const rows = sheet.getRange(2, 1, count, EXAMPLE_HEADERS.length).getValues();
  return rows
    .filter((r) => r[0] === true && r[1] && r[2])
    .slice(-CONFIG.FEW_SHOT_LIMIT)
    .map((r) => '原句：' + r[1] + '\n結果：' + r[2]);
}

/** 由使用者修正自動產生的學習案例候選（enabled=false，等待人工審核） */
function appendExampleCandidate(rawText, expectedJson) {
  const sheet = getSheet_(EXAMPLE_SHEET);
  sheet.appendRow([
    false, rawText, expectedJson,
    '由使用者修正自動產生，確認無誤後請勾選 enabled', new Date()
  ]);
  // 只在剛寫入的這一列補上核取方塊，方便人工審核
  sheet.getRange(sheet.getLastRow(), 1).insertCheckboxes();
}

// ---------------------------------------------------------------- Reflexion memory

function appendReflectionMemory(record) {
  record.memoryId = record.memoryId || Utilities.getUuid();
  record.createdAt = record.createdAt || new Date();
  record.memoryStatus = record.memoryStatus || (CONFIG.AUTO_MEMORY_ACTIVE ? 'active' : 'disabled');
  record.usedCount = record.usedCount || 0;

  const row = REFLECTION_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  getSheet_(REFLECTION_SHEET).appendRow(row);
  return record.memoryId;
}

function loadActiveReflectionMemory(groupId, limit) {
  const sheet = getSheet_(REFLECTION_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];

  const rows = sheet.getRange(2, 1, count, REFLECTION_HEADERS.length).getValues();
  return rows
    .map((r) => toRecordWithHeaders_(r, REFLECTION_HEADERS))
    .filter((r) => r.groupId === groupId && r.memoryStatus === 'active' && r.reflectionText)
    .slice(-Math.max(1, limit || CONFIG.MEMORY_LIMIT || 3));
}

function reflectionMemoryExists(sourceLogId) {
  if (!sourceLogId) return false;
  const sheet = getSheet_(REFLECTION_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return false;

  const col = REFLECTION_HEADERS.indexOf('sourceLogId') + 1;
  const ids = sheet.getRange(2, col, count, 1).getValues();
  return ids.some((r) => r[0] === sourceLogId);
}

// ---------------------------------------------------------------- Profile memory

function ensureProfileMemorySheet() {
  return getSheet_(PROFILE_MEMORY_SHEET);
}

function appendProfileMemory(record) {
  const now = new Date();
  record.memory_id = record.memory_id || Utilities.getUuid();
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;
  record.status = record.status || 'pending';
  record.variants_json = record.variants_json || safeJsonStringify_([]);
  record.rule_json = record.rule_json || safeJsonStringify_({});
  record.evidence_log_ids = record.evidence_log_ids || safeJsonStringify_([]);

  const row = PROFILE_MEMORY_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  ensureProfileMemorySheet().appendRow(row);
  return record.memory_id;
}

function updateProfileMemoryStatus(memoryId, status) {
  const sheet = ensureProfileMemorySheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return false;

  const idCol = PROFILE_MEMORY_HEADERS.indexOf('memory_id') + 1;
  const statusCol = PROFILE_MEMORY_HEADERS.indexOf('status') + 1;
  const updatedCol = PROFILE_MEMORY_HEADERS.indexOf('updated_at') + 1;
  const ids = sheet.getRange(2, idCol, count, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === memoryId) {
      sheet.getRange(i + 2, statusCol).setValue(status);
      sheet.getRange(i + 2, updatedCol).setValue(new Date());
      return true;
    }
  }
  return false;
}

function findProfileMemoriesByGroup(groupId) {
  const sheet = ensureProfileMemorySheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];

  const rows = sheet.getRange(2, 1, count, PROFILE_MEMORY_HEADERS.length).getValues();
  return rows
    .map((r) => toRecordWithHeaders_(r, PROFILE_MEMORY_HEADERS))
    .filter((r) => r.group_id === groupId);
}

function loadRelevantProfileMemories(groupId) {
  if (!CONFIG.PROFILE_MEMORY_ENABLED || !groupId) return [];
  return findProfileMemoriesByGroup(groupId).filter((m) => m.status === 'active');
}

function mergeDuplicateProfileMemories(groupId) {
  const seen = {};
  findProfileMemoriesByGroup(groupId).forEach((m) => {
    const key = [m.memory_type, m.subject_id, m.canonical_value].join('|');
    if (seen[key]) updateProfileMemoryStatus(m.memory_id, 'superseded');
    else seen[key] = true;
  });
}

// ---------------------------------------------------------------- Decision log

function ensureDecisionLogSheet() {
  return getSheet_(DECISION_LOG_SHEET);
}

function createDecisionRecord(record) {
  if (!CONFIG.DECISION_LOG_ENABLED) return '';
  const now = new Date();
  record.decision_id = record.decision_id || ('DEC-' + Utilities.getUuid());
  record.status = record.status || 'pending';
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;

  const row = DECISION_LOG_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  ensureDecisionLogSheet().appendRow(row);
  return record.decision_id;
}

function getDecisionById(decisionId) {
  const sheet = ensureDecisionLogSheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return null;

  const rows = sheet.getRange(2, 1, count, DECISION_LOG_HEADERS.length).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const record = toRecordWithHeaders_(rows[i], DECISION_LOG_HEADERS);
    if (record.decision_id === decisionId) return record;
  }
  return null;
}

function updateDecisionRecord_(decisionId, fields) {
  const sheet = ensureDecisionLogSheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return false;

  const ids = sheet.getRange(2, 1, count, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] !== decisionId) continue;
    Object.keys(fields).forEach((key) => {
      const idx = DECISION_LOG_HEADERS.indexOf(key);
      if (idx !== -1) sheet.getRange(i + 2, idx + 1).setValue(fields[key]);
    });
    sheet.getRange(i + 2, DECISION_LOG_HEADERS.indexOf('updated_at') + 1).setValue(new Date());
    return true;
  }
  return false;
}

function recordSelectedOption(decisionId, optionId) {
  return updateDecisionRecord_(decisionId, {
    selected_option_id: optionId,
    status: 'selected'
  });
}

function recordDecisionExecution(decisionId, finalAction) {
  return updateDecisionRecord_(decisionId, {
    final_action_json: safeJsonStringify_(finalAction),
    status: 'executed'
  });
}

function recordDecisionOutcome(decisionId, outcome, feedback) {
  return updateDecisionRecord_(decisionId, {
    outcome: outcome,
    feedback: feedback || '',
    status: 'closed'
  });
}

function findLatestDecisionForFeedback(groupId, userId) {
  const sheet = ensureDecisionLogSheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return null;

  const rows = sheet.getRange(2, 1, count, DECISION_LOG_HEADERS.length).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const record = toRecordWithHeaders_(rows[i], DECISION_LOG_HEADERS);
    if (record.group_id !== groupId) continue;
    if (userId && record.requester_user_id && record.requester_user_id !== userId) continue;
    if (record.status === 'executed' || record.status === 'selected') return record;
  }
  return null;
}

// ---------------------------------------------------------------- Family profile / routine model

function ensureFamilyProfileSheet() {
  return getSheet_(FAMILY_PROFILE_SHEET);
}

function ensureRoutineModelSheet() {
  return getSheet_(ROUTINE_MODEL_SHEET);
}

function appendFamilyProfile(record) {
  const now = new Date();
  record.profile_id = record.profile_id || Utilities.getUuid();
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;
  record.aliases_json = record.aliases_json || safeJsonStringify_([]);
  const row = FAMILY_PROFILE_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  ensureFamilyProfileSheet().appendRow(row);
  return record.profile_id;
}

function appendRoutineModel(record) {
  const now = new Date();
  record.routine_id = record.routine_id || Utilities.getUuid();
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;
  record.participant_ids_json = record.participant_ids_json || safeJsonStringify_([]);
  const row = ROUTINE_MODEL_HEADERS.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : '');
  ensureRoutineModelSheet().appendRow(row);
  return record.routine_id;
}

function findFamilyProfilesByGroup(groupId) {
  const sheet = ensureFamilyProfileSheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  const rows = sheet.getRange(2, 1, count, FAMILY_PROFILE_HEADERS.length).getValues();
  return rows
    .map((r) => toRecordWithHeaders_(r, FAMILY_PROFILE_HEADERS))
    .filter((r) => !r.group_id || r.group_id === '*' || r.group_id === groupId);
}

function findRoutineModelsByGroup(groupId) {
  const sheet = ensureRoutineModelSheet();
  const count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  const rows = sheet.getRange(2, 1, count, ROUTINE_MODEL_HEADERS.length).getValues();
  return rows
    .map((r) => toRecordWithHeaders_(r, ROUTINE_MODEL_HEADERS))
    .filter((r) => !r.group_id || r.group_id === '*' || r.group_id === groupId);
}

function clearSheetRows_(sheet) {
  const count = sheet.getLastRow() - 1;
  if (count > 0) sheet.getRange(2, 1, count, sheet.getLastColumn()).clearContent();
}

function replaceSheetRows_(sheetName, headers, records) {
  const sheet = getSheet_(sheetName);
  const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (currentHeaders.join('|') !== headers.join('|')) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  clearSheetRows_(sheet);
  if (!records.length) return 0;
  const rows = records.map((record) => headers.map((h) =>
    (record[h] !== undefined && record[h] !== null) ? record[h] : ''));
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function backupProfileMemorySheet_() {
  const ss = getLearningSpreadsheet_();
  const source = ensureProfileMemorySheet();
  const stamp = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd_HHmmss');
  const backupName = 'profile_memory_backup_' + stamp;
  const backup = source.copyTo(ss).setName(backupName);
  ss.setActiveSheet(backup);
  ss.moveActiveSheet(ss.getNumSheets());
  if (!ss.getSheetByName(backupName) || backup.getLastRow() < 1) {
    throw new Error('profile_memory backup failed');
  }
  return { name: backupName, rows: Math.max(0, backup.getLastRow() - 1), columns: backup.getLastColumn() };
}

function seedWhatIfV1Data() {
  const now = new Date();
  const backup = backupProfileMemorySheet_();

  const familyRows = [{
    profile_id: 'member-father',
    group_id: '*',
    member_id: 'father',
    name: '家長A',
    aliases_json: safeJsonStringify_(['爸爸', '先生', '家長A']),
    role: 'adult',
    age_years: '',
    home_location: '住家區',
    work_location: '市區',
    weekday_start: '08:30',
    weekday_end: '17:00',
    requires_adult_companion: false,
    notes: '平日08:30-17:00在市區工作；全家平日約07:00從住家區出發，19:00回到住家區。',
    created_at: now,
    updated_at: now
  }, {
    profile_id: 'member-mother',
    group_id: '*',
    member_id: 'mother',
    name: '家長B',
    aliases_json: safeJsonStringify_(['媽媽', '太太', '家長B']),
    role: 'adult',
    age_years: '',
    home_location: '住家區',
    work_location: '市區',
    weekday_start: '08:30',
    weekday_end: '18:00',
    requires_adult_companion: false,
    notes: '平日08:30-18:00在市區工作；盡量避免平日下午請假。',
    created_at: now,
    updated_at: now
  }, {
    profile_id: 'member-child-01',
    group_id: '*',
    member_id: 'child_01',
    name: '孩子A',
    aliases_json: safeJsonStringify_(['大女兒', '孩子A', '女兒']),
    role: 'child',
    age_years: 5,
    home_location: '住家區',
    work_location: '',
    weekday_start: '',
    weekday_end: '',
    requires_adult_companion: true,
    notes: '5歲，不能單獨行動，外出、接送及就醫需要成人陪同。',
    created_at: now,
    updated_at: now
  }, {
    profile_id: 'member-child-02',
    group_id: '*',
    member_id: 'child_02',
    name: '孩子B',
    aliases_json: safeJsonStringify_(['小女兒', '孩子B', '寶寶']),
    role: 'infant',
    age_years: 0,
    home_location: '住家區',
    work_location: '',
    weekday_start: '',
    weekday_end: '',
    requires_adult_companion: true,
    notes: '未滿1歲，所有外出、接送及照護需要成人陪同。',
    created_at: now,
    updated_at: now
  }];

  const routineRows = [{
    routine_id: 'routine-father-work',
    group_id: '*',
    title: '家長A工作',
    participant_ids_json: safeJsonStringify_(['father']),
    owner_id: 'father',
    weekday: '1,2,3,4,5',
    start_time: '08:30',
    end_time: '17:00',
    location: '市區',
    movable: false,
    event_type: 'work',
    needs_adult: false,
    notes: '工作時段不可直接移動，可透過請假方案處理。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-mother-work',
    group_id: '*',
    title: '家長B工作',
    participant_ids_json: safeJsonStringify_(['mother']),
    owner_id: 'mother',
    weekday: '1,2,3,4,5',
    start_time: '08:30',
    end_time: '18:00',
    location: '市區',
    movable: false,
    event_type: 'work',
    needs_adult: false,
    notes: '工作時段不可直接移動，可透過請假方案處理。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-weekday-morning-commute',
    group_id: '*',
    title: '全家平日早上通勤',
    participant_ids_json: safeJsonStringify_(['father', 'mother', 'child_01', 'child_02']),
    owner_id: 'father',
    weekday: '1,2,3,4,5',
    start_time: '07:00',
    end_time: '08:30',
    location: '住家區到市區',
    movable: false,
    event_type: 'commute',
    needs_adult: true,
    notes: '平日約07:00從住家區出發；第一版固定通勤時間，不做精準交通預測。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-weekday-evening-commute',
    group_id: '*',
    title: '全家接送回家',
    participant_ids_json: safeJsonStringify_(['father', 'mother', 'child_01', 'child_02']),
    owner_id: 'father',
    weekday: '1,2,3,4,5',
    start_time: '17:00',
    end_time: '19:00',
    location: '市區到住家區',
    movable: false,
    event_type: 'pickup_commute',
    needs_adult: true,
    notes: '第一版用一筆全家接送回家表示放學接送與回家通勤，避免重複計算。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-child-school',
    group_id: '*',
    title: '孩子A上學',
    participant_ids_json: safeJsonStringify_(['child_01']),
    owner_id: '',
    weekday: '1,2,3,4,5',
    start_time: '08:20',
    end_time: '18:00',
    location: '市區',
    movable: false,
    event_type: 'school',
    needs_adult: false,
    notes: '上學時段不可直接移動。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-child-02-school',
    group_id: '*',
    title: '孩子B上學',
    participant_ids_json: safeJsonStringify_(['child_02']),
    owner_id: '',
    weekday: '1,2,3,4,5',
    start_time: '08:00',
    end_time: '17:30',
    location: '市區',
    movable: false,
    event_type: 'school',
    needs_adult: false,
    notes: '上學時段不可直接移動。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-kids-bath',
    group_id: '*',
    title: '小孩洗澡',
    participant_ids_json: safeJsonStringify_(['mother', 'child_01', 'child_02']),
    owner_id: 'mother',
    weekday: '1,2,3,4,5,6,7',
    start_time: '20:00',
    end_time: '20:30',
    location: '住家區',
    movable: false,
    event_type: 'care',
    needs_adult: true,
    notes: '家庭照護 routine，第一版不直接移動。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-kids-bedtime',
    group_id: '*',
    title: '小孩就寢',
    participant_ids_json: safeJsonStringify_(['mother', 'child_01', 'child_02']),
    owner_id: 'mother',
    weekday: '1,2,3,4,5,6,7',
    start_time: '21:00',
    end_time: '21:30',
    location: '住家區',
    movable: false,
    event_type: 'care',
    needs_adult: true,
    notes: '就寢 routine 不直接移動。',
    created_at: now,
    updated_at: now
  }, {
    routine_id: 'routine-sunday-family-activity',
    group_id: '*',
    title: '週日家庭活動',
    participant_ids_json: safeJsonStringify_(['father', 'mother', 'child_01', 'child_02']),
    owner_id: 'father',
    weekday: '7',
    start_time: '16:00',
    end_time: '18:00',
    location: '住家區',
    movable: true,
    event_type: 'family_activity',
    needs_adult: true,
    notes: '週日活動可在 What-if 中移動。',
    created_at: now,
    updated_at: now
  }];

  const profileRows = [{
    memory_id: 'whatif-v1-pref-avoid-mother-leave',
    group_id: '*',
    subject_id: 'mother',
    memory_type: 'preference',
    canonical_value: '平日下午新增小孩行程時，優先改日期，避免家長B請假',
    variants_json: safeJsonStringify_([]),
    rule_json: safeJsonStringify_({
      situation: '平日下午新增小孩行程',
      preference: '優先改日期，避免家長B請假'
    }),
    evidence_log_ids: safeJsonStringify_([]),
    source_type: 'explicit_statement',
    confidence: 1,
    status: 'active',
    created_at: now,
    updated_at: now,
    last_used_at: ''
  }];

  const familyCount = replaceSheetRows_(FAMILY_PROFILE_SHEET, FAMILY_PROFILE_HEADERS, familyRows);
  const routineCount = replaceSheetRows_(ROUTINE_MODEL_SHEET, ROUTINE_MODEL_HEADERS, routineRows);
  const profileCount = replaceSheetRows_(PROFILE_MEMORY_SHEET, PROFILE_MEMORY_HEADERS, profileRows);
  return {
    familyProfileRows: familyCount,
    routineModelRows: routineCount,
    profileMemoryRows: profileCount,
    profileMemoryBackupName: backup.name,
    profileMemoryBackupRows: backup.rows
  };
}

function verifyWhatIfV1Data() {
  return {
    familyProfileRows: findFamilyProfilesByGroup('*').length,
    routineModelRows: findRoutineModelsByGroup('*').length,
    activeProfileMemoryRows: findProfileMemoriesByGroup('*').filter((m) => m.status === 'active').length,
    familyProfileHeaders: FAMILY_PROFILE_HEADERS,
    routineModelHeaders: ROUTINE_MODEL_HEADERS,
    profileMemoryHeaders: PROFILE_MEMORY_HEADERS
  };
}

function markLogSuspectedWrong(logId, reason) {
  const sheet = getSheet_(LOG_SHEET);
  const count = sheet.getLastRow() - 1;
  if (count < 1) return;

  const ids = sheet.getRange(2, 1, count, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === logId) {
      sheet.getRange(i + 2, LOG_HEADERS.indexOf('status') + 1).setValue(STATUS.ERROR);
      sheet.getRange(i + 2, LOG_HEADERS.indexOf('errorMessage') + 1)
        .setValue('suspected_wrong: ' + (reason || ''));
      return;
    }
  }
}

// ---------------------------------------------------------------- 衝突等待狀態

/**
 * 衝突詢問的等待狀態存在 CacheService（暫時性，逾時自動消失），
 * 但決策過程的每一步都會寫進 log 表並以 relatedLogId 串成鏈——
 * 「AI 提問 → 人類決定 → 執行結果」的完整軌跡就是日後可挖掘的偏好資料。
 */

function savePendingConflict(groupId, data) {
  CacheService.getScriptCache().put(
    'pending:' + groupId,
    JSON.stringify(data),
    CONFIG.PENDING_TTL_MINUTES * 60
  );
}

function getPendingConflict(groupId) {
  const raw = CacheService.getScriptCache().get('pending:' + groupId);
  return raw ? JSON.parse(raw) : null;
}

function clearPendingConflict(groupId) {
  CacheService.getScriptCache().remove('pending:' + groupId);
}
