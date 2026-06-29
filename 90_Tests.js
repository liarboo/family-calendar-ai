// ---------------------------------------------------------------- 部署初始化

/**
 * 部署後請在 Apps Script 編輯器手動執行一次 setupOnce：
 *   1. 觸發 Sheets / Calendar / UrlFetch 的授權流程（webhook 執行時無法跳授權視窗）
 *   2. 自動建立 learning_log 試算表，並在記錄檔印出網址
 */
function setupOnce() {
  const ss = getLearningSpreadsheet_();
  Logger.log('learning_log 試算表：' + ss.getUrl());
  Logger.log('Calendar 連線正常：' + getCalendar_().getName());
  Logger.log('簽章驗證：' + (CONFIG.VERIFY_SIGNATURE ? '啟用' : '關閉'));
}

function setupWhatIfV1Data() {
  const result = seedWhatIfV1Data();
  Logger.log('What-if V1 data seeded. profile backup=' + result.profileMemoryBackupName);
  Logger.log(JSON.stringify(verifyWhatIfV1Data()));
  return result;
}

function testWhatIfV1DataReadable() {
  const data = verifyWhatIfV1Data();
  const routines = findRoutineModelsByGroup('*');
  const child01School = findTestRoutineById_(routines, 'routine-child-school');
  const child02School = findTestRoutineById_(routines, 'routine-child-02-school');
  const bath = findTestRoutineById_(routines, 'routine-kids-bath');
  const sunday = findTestRoutineById_(routines, 'routine-sunday-family-activity');
  const wrongPickup = routines.filter((r) =>
    r.start_time === '16:00' && r.end_time === '17:00' && r.location === '住家區' &&
    /接送|放學/.test(r.title || ''));

  assert_(data.familyProfileRows >= 4, 'family_profile should have baseline members');
  assert_(data.routineModelRows >= 9, 'routine_model should include confirmed baseline routines');
  assert_(data.activeProfileMemoryRows >= 1, 'profile_memory should have initial active preference');
  assert_(child01School.start_time === '08:20' && child01School.end_time === '18:00' &&
    child01School.location === '市區', '孩子A上學 should be 08:20-18:00 at 市區');
  assert_(child02School.start_time === '08:00' && child02School.end_time === '17:30' &&
    child02School.location === '市區' && child02School.event_type === 'school',
    '孩子B上學 should be 08:00-17:30 at 市區');
  assert_(String(bath.movable).toUpperCase() === 'FALSE' || bath.movable === false,
    '小孩洗澡 movable should be FALSE');
  assert_(sunday.weekday === '7' && sunday.start_time === '16:00' && sunday.end_time === '18:00' &&
    sunday.location === '住家區' && (String(sunday.movable).toUpperCase() === 'TRUE' || sunday.movable === true),
    '週日家庭活動 should be Sunday 16:00-18:00 at 住家區 and movable TRUE');
  assert_(wrongPickup.length === 0, 'should not include duplicate 16:00-17:00 住家區 pickup routine');
}

function findTestRoutineById_(routines, routineId) {
  const found = routines.filter((r) => r.routine_id === routineId)[0];
  assert_(!!found, 'missing routine: ' + routineId);
  return found;
}

// From test gemini.js
function testGeminiApi() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' +
    apiKey;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: '把這句話轉成 JSON：明天下午3點帶女兒看牙醫。只回傳 JSON。'
          }
        ]
      }
    ]
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log(response.getResponseCode());
  Logger.log(response.getContentText());
}

// From test line scret.js
function testLineProperties() {
  const props = PropertiesService.getScriptProperties();

  const secret = props.getProperty('LINE_CHANNEL_SECRET');
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  if (!secret) {
    throw new Error('LINE_CHANNEL_SECRET 未設定');
  }

  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN 未設定');
  }

  Logger.log('LINE_CHANNEL_SECRET exists = true');
  Logger.log('LINE_CHANNEL_SECRET length = ' + secret.length);

  Logger.log('LINE_CHANNEL_ACCESS_TOKEN exists = true');
  Logger.log('LINE_CHANNEL_ACCESS_TOKEN length = ' + token.length);
}

// From test Channel Access Token.js
function testLineAccessToken() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN 未設定');
  }

  const url = 'https://api.line.me/v2/bot/info';

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token
    },
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  Logger.log('HTTP code = ' + code);
  Logger.log('Response = ' + body);

  if (code !== 200) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN 測試失敗');
  }
}

// From test calendar ID.js
function testCreateCalendarEvent() {
  const props = PropertiesService.getScriptProperties();

  const calendarId = props.getProperty('GOOGLE_CALENDAR_ID');

  Logger.log('GOOGLE_CALENDAR_ID = ' + calendarId);

  if (!calendarId) {
    throw new Error('GOOGLE_CALENDAR_ID 沒有設定在 Script Properties');
  }

  const calendar = CalendarApp.getCalendarById(calendarId);

  if (!calendar) {
    throw new Error(
      '找不到這個 Calendar。請檢查 Calendar ID 是否正確，或目前 Apps Script 帳號是否有權限：' +
      calendarId
    );
  }

  Logger.log('Calendar name = ' + calendar.getName());

  const start = new Date();
  start.setHours(start.getHours() + 1);

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const event = calendar.createEvent(
    '測試：Apps Script 寫入家庭行事曆',
    start,
    end,
    {
      description: '這是 Apps Script 權限測試'
    }
  );

  Logger.log('Event created: ' + event.getId());
}

// From test line sign.js
function testLineSignatureFunction() {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('LINE_CHANNEL_SECRET');

  if (!secret) {
    throw new Error('LINE_CHANNEL_SECRET 未設定');
  }

  const body = '{"events":[]}';

  const signatureBytes = Utilities.computeHmacSha256Signature(body, secret);
  const signature = Utilities.base64Encode(signatureBytes);

  Logger.log('Signature generated = true');
  Logger.log('Signature length = ' + signature.length);

  if (!signature) {
    throw new Error('Signature 產生失敗');
  }
}

// ---------------------------------------------------------------- Reflexion tests

function assert_(condition, message) {
  if (!condition) throw new Error(message);
}

function testReflectionSheetSetup() {
  const sheet = getSheet_(REFLECTION_SHEET);
  const headers = sheet.getRange(1, 1, 1, REFLECTION_HEADERS.length).getValues()[0];
  assert_(headers.join('|') === REFLECTION_HEADERS.join('|'), 'reflection_memory schema mismatch');
}

function testAppendReflectionMemory() {
  const sourceLogId = 'test-log-' + Utilities.getUuid();
  appendReflectionMemory({
    groupId: 'test-group',
    sourceLogId: sourceLogId,
    triggerType: 'error',
    rawText: '測試反思',
    trajectoryJson: '{}',
    evaluatorResult: '{}',
    reflectionText: '下次遇到測試反思時要確認日期。',
    memoryStatus: 'disabled'
  });
  assert_(reflectionMemoryExists(sourceLogId), 'reflection memory was not appended');
}

function testBuildPromptWithReflectionMemory() {
  const oldEnabled = CONFIG.REFLEXION_ENABLED;
  const groupId = 'test-group-' + Utilities.getUuid();
  const text = '下週二牙醫';
  let prompt = '';

  try {
    CONFIG.REFLEXION_ENABLED = true;
    appendReflectionMemory({
      groupId: groupId,
      sourceLogId: 'test-log-' + Utilities.getUuid(),
      triggerType: 'error',
      rawText: text,
      trajectoryJson: '{}',
      evaluatorResult: '{}',
      reflectionText: '測試記憶：下週二要解析成日期。',
      memoryStatus: 'active'
    });
    prompt = buildPrompt_(text, null, [], null, groupId);
  } finally {
    CONFIG.REFLEXION_ENABLED = oldEnabled;
  }

  assert_(prompt.indexOf('【下次應遵守的反思規則】') !== -1, 'memory block missing');
  assert_(prompt.indexOf('測試記憶：下週二要解析成日期。') !== -1, 'memory text missing');
}

function testEvaluateLogForReflection() {
  assert_(evaluateLogForReflection({ status: STATUS.ERROR, errorMessage: 'boom' }).shouldReflect,
    'error should reflect');
  assert_(evaluateLogForReflection({ status: STATUS.CORRECTED }).shouldReflect,
    'corrected should reflect');
  assert_(!evaluateLogForReflection({ status: STATUS.PENDING }).shouldReflect,
    'pending should not reflect');
}

function testLlmFallback() {
  const oldProvider = CONFIG.LLM_PROVIDER;
  const oldFallback = CONFIG.LLM_FALLBACK_ENABLED;
  const oldOpenAI = callOpenAI_;
  const oldGemini = callGemini_;
  let parsed = null;

  try {
    CONFIG.LLM_PROVIDER = 'openai';
    CONFIG.LLM_FALLBACK_ENABLED = true;
    callOpenAI_ = function () { throw new Error('forced openai failure'); };
    callGemini_ = function () { return '{"intent":"none","event":null}'; };
    parsed = parseWithLLM('hi', null, [], null, '');
  } finally {
    callOpenAI_ = oldOpenAI;
    callGemini_ = oldGemini;
    CONFIG.LLM_PROVIDER = oldProvider;
    CONFIG.LLM_FALLBACK_ENABLED = oldFallback;
  }

  assert_(parsed.intent === INTENTS.NONE, 'fallback parse failed');
  assert_(parsed._llmProvider === 'gemini', 'fallback provider metadata missing');
  assert_(!!parsed._primaryError, 'primary error metadata missing');
}

function testAutoMemoryActiveWritesReflection() {
  const oldEnabled = CONFIG.REFLEXION_ENABLED;
  const oldAuto = CONFIG.AUTO_MEMORY_ACTIVE;
  const oldReflectionOnCorrection = CONFIG.REFLECTION_ON_CORRECTION;
  const oldCall = callLlmRawWithFallback_;
  const props = PropertiesService.getScriptProperties();
  const sourceLogId = 'test-auto-memory-' + Utilities.getUuid();
  const groupId = 'test-group-' + Utilities.getUuid();

  try {
    props.setProperties({
      REFLEXION_ENABLED: 'true',
      AUTO_MEMORY_ACTIVE: 'true',
      MEMORY_LIMIT: '3',
      LLM_FALLBACK_ENABLED: 'true'
    }, false);
    CONFIG.REFLEXION_ENABLED = true;
    CONFIG.AUTO_MEMORY_ACTIVE = true;
    CONFIG.REFLECTION_ON_CORRECTION = true;
    callLlmRawWithFallback_ = function () {
      return { text: '{"reflectionText":"測試自動啟用反思記憶"}', provider: 'test', primaryError: '' };
    };

    maybeCreateReflectionMemory_({
      logId: sourceLogId,
      groupId: groupId,
      rawText: '明天下午3點測試牙醫',
      intent: INTENTS.CREATE,
      geminiJson: '{}',
      finalJson: '{}',
      status: STATUS.CORRECTED,
      correctionText: '不是3點，是4點'
    }, 'corrected');
  } finally {
    callLlmRawWithFallback_ = oldCall;
    CONFIG.REFLEXION_ENABLED = oldEnabled;
    CONFIG.AUTO_MEMORY_ACTIVE = oldAuto;
    CONFIG.REFLECTION_ON_CORRECTION = oldReflectionOnCorrection;
  }

  assert_(reflectionMemoryExists(sourceLogId), 'auto memory reflection was not appended');
  const memories = loadActiveReflectionMemory(groupId, 1);
  assert_(memories.length === 1, 'auto memory was not active');
  assert_(memories[0].reflectionText === '測試自動啟用反思記憶', 'reflection text mismatch');
}

// ---------------------------------------------------------------- Profile / decision tests

function testProfileAliasLearning() {
  const oldEnabled = CONFIG.PROFILE_MEMORY_ENABLED;
  const oldExplicit = CONFIG.PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE;
  const oldCall = callLlmRawWithFallback_;
  const groupId = 'test-profile-' + Utilities.getUuid();
  const sourceLogId = 'test-log-' + Utilities.getUuid();

  try {
    CONFIG.PROFILE_MEMORY_ENABLED = true;
    CONFIG.PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE = true;
    callLlmRawWithFallback_ = function () {
      return {
        text: JSON.stringify({
          candidates: [{
            memoryType: 'alias',
            subjectId: 'daughter_01',
            canonicalValue: '孩子A',
            variants: ['大女兒'],
            sourceType: 'explicit_statement',
            confidence: 0.95,
            reason: '使用者明確陳述'
          }]
        })
      };
    };

    extractProfileMemoryCandidates({
      groupId: groupId,
      userId: 'user-1',
      sourceLogId: sourceLogId,
      rawText: '大女兒就是孩子A',
      originalParsedResult: {},
      correctionText: '',
      finalCorrectResult: {}
    });
  } finally {
    callLlmRawWithFallback_ = oldCall;
    CONFIG.PROFILE_MEMORY_ENABLED = oldEnabled;
    CONFIG.PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE = oldExplicit;
  }

  const memories = findProfileMemoriesByGroup(groupId);
  assert_(memories.length === 1, 'profile alias was not written');
  assert_(memories[0].canonical_value === '孩子A', 'canonical value mismatch');
  assert_(safeJsonParse_(memories[0].variants_json, []).indexOf('大女兒') !== -1, 'variant missing');
  assert_(memories[0].status === 'active', 'explicit alias should be active');
}

function testResolvePersonAlias() {
  const groupId = 'test-resolve-' + Utilities.getUuid();
  appendProfileMemory({
    group_id: groupId,
    subject_id: 'daughter_01',
    memory_type: 'alias',
    canonical_value: '孩子A',
    variants_json: safeJsonStringify_(['大女兒']),
    source_type: 'test',
    confidence: 1,
    status: 'active'
  });

  const result = resolvePersonAlias(groupId, '大女兒');
  assert_(result.status === 'resolved', 'alias should resolve');
  assert_(result.rawPersonText === '大女兒', 'raw person mismatch');
  assert_(result.canonicalPersonName === '孩子A', 'canonical person mismatch');
}

function testAvoidsSingleEventActivePreference() {
  const oldEnabled = CONFIG.PROFILE_MEMORY_ENABLED;
  const oldAuto = CONFIG.PROFILE_MEMORY_AUTO_ACTIVE;
  const oldCall = callLlmRawWithFallback_;
  const groupId = 'test-pref-' + Utilities.getUuid();

  try {
    CONFIG.PROFILE_MEMORY_ENABLED = true;
    CONFIG.PROFILE_MEMORY_AUTO_ACTIVE = true;
    callLlmRawWithFallback_ = function () {
      return {
        text: JSON.stringify({
          candidates: [{
            memoryType: 'preference',
            subjectId: 'wife',
            canonicalValue: '太太固定負責接大女兒',
            variants: [],
            sourceType: 'inferred_from_event',
            confidence: 0.92,
            reason: '單一事件推論'
          }]
        })
      };
    };

    extractProfileMemoryCandidates({
      groupId: groupId,
      userId: 'user-1',
      sourceLogId: 'test-log-' + Utilities.getUuid(),
      rawText: '太太星期五接大女兒',
      originalParsedResult: {},
      correctionText: '',
      finalCorrectResult: {}
    });
  } finally {
    callLlmRawWithFallback_ = oldCall;
    CONFIG.PROFILE_MEMORY_ENABLED = oldEnabled;
    CONFIG.PROFILE_MEMORY_AUTO_ACTIVE = oldAuto;
  }

  const activePrefs = findProfileMemoriesByGroup(groupId)
    .filter((m) => m.memory_type === 'preference' && m.status === 'active');
  assert_(activePrefs.length === 0, 'single inferred preference must not become active');
}

function testDetectTimeConflict() {
  const newEvent = {
    title: '看牙醫',
    start: new Date('2026-06-26T17:00:00+08:00'),
    end: new Date('2026-06-26T18:00:00+08:00')
  };
  const existing = [{
    eventId: 'existing-1',
    title: '接小孩',
    start: '2026-06-26T17:30:00+08:00',
    end: '2026-06-26T18:30:00+08:00'
  }];

  const conflicts = detectCalendarConflicts(newEvent, { events: existing });
  assert_(conflicts.some((c) => c.type === 'TIME_OVERLAP' && c.severity === 'hard'),
    'hard overlap conflict missing');
}

function testWhatIfScenarioBestAndSecondBest() {
  const eventDraft = {
    title: '看牙醫',
    start: '2026-06-26T17:00:00+08:00',
    end: '2026-06-26T18:00:00+08:00'
  };
  const conflicts = [{ type: 'TIME_OVERLAP', severity: 'hard', eventId: 'existing-1', message: '重疊', details: {} }];
  const options = generateWhatIfScenarios({ eventDraft: eventDraft, conflicts: conflicts, profileContext: {} });
  const possible = removeImpossibleScenarios(options, conflicts);
  const ranked = rankScenarios(possible, { conflicts: conflicts });

  assert_(options.some((o) => o.type === 'TIME_SHIFT'), 'TIME_SHIFT option missing');
  assert_(options.some((o) => o.type === 'METHOD_CHANGE'), 'METHOD_CHANGE option missing');
  assert_(!possible.some((o) => o.hardConflict), 'hard conflict option should be removed');
  assert_(ranked.best && ranked.secondBest, 'best and second best required');
}

function testWhatIfUsesLlmSpecificScenarios() {
  const oldCall = callWhatIfPlannerLlm_;
  const eventDraft = {
    title: '看牙醫',
    start: '2026-06-26T17:00:00+08:00',
    end: '2026-06-26T18:00:00+08:00'
  };
  const conflicts = [{ type: 'TIME_OVERLAP', severity: 'hard', eventId: 'existing-1', message: '重疊', details: {} }];
  let options = [];

  try {
    callWhatIfPlannerLlm_ = function () {
      return JSON.stringify({
        options: [
          {
            optionId: 'A',
            type: 'AS_PROPOSED',
            title: '原時間會撞到接小孩',
            action: { kind: 'create', event: eventDraft },
            consequences: ['會與接小孩重疊'],
            assumptions: [],
            hardConflict: true,
            requiresConfirmation: false,
            uncertainty: 'low'
          },
          {
            optionId: 'B',
            type: 'TIME_SHIFT',
            title: '把牙醫改到 18:45',
            action: {
              kind: 'create',
              event: {
                title: '看牙醫',
                start: '2026-06-26T18:45:00+08:00',
                end: '2026-06-26T19:45:00+08:00'
              }
            },
            consequences: ['避開接小孩'],
            assumptions: ['牙醫 18:45 有診'],
            hardConflict: false,
            requiresConfirmation: true,
            uncertainty: 'medium'
          },
          {
            optionId: 'C',
            type: 'METHOD_CHANGE',
            title: '請另一位家人接小孩，牙醫維持原時間',
            action: { kind: 'ask_confirmation', event: eventDraft },
            consequences: ['保留牙醫原時間'],
            assumptions: ['另一位家人可接送'],
            hardConflict: false,
            requiresConfirmation: true,
            uncertainty: 'medium'
          }
        ]
      });
    };
    options = generateWhatIfScenarios({
      eventDraft: eventDraft,
      conflicts: conflicts,
      profileContext: { people: [], aliases: [], constraints: [], preferences: [] },
      research: { evidenceStatus: 'not_searched' }
    });
  } finally {
    callWhatIfPlannerLlm_ = oldCall;
  }

  assert_(options.some((o) => o.title === '把牙醫改到 18:45'), 'LLM TIME_SHIFT was not used');
  assert_(options.some((o) => o.title.indexOf('另一位家人') !== -1), 'LLM METHOD_CHANGE was not used');
}

function testRevalidateDecisionOptionRejectsChangedCalendar() {
  const decision = {
    event_draft_json: safeJsonStringify_({
      title: '看牙醫',
      start: '2026-06-26T17:00:00+08:00',
      end: '2026-06-26T18:00:00+08:00'
    }),
    options_json: safeJsonStringify_([{ optionId: 'A', type: 'AS_PROPOSED', action: { kind: 'create' } }]),
    conflicts_json: safeJsonStringify_([{ type: 'TIME_OVERLAP', eventId: 'existing-1' }])
  };
  const result = revalidateDecisionOption(decision, 'A', {
    events: [{
      eventId: 'existing-1',
      title: '接小孩',
      start: '2026-06-26T17:00:00+08:00',
      end: '2026-06-26T18:30:00+08:00'
    }]
  });
  assert_(!result.valid, 'changed calendar state should invalidate stale option');
}

function testNewFeatureFlagsOffKeepsExistingPromptFlow() {
  const oldProfile = CONFIG.PROFILE_MEMORY_ENABLED;
  const oldWhatIf = CONFIG.WHAT_IF_ENABLED;
  const oldDecision = CONFIG.DECISION_LOG_ENABLED;
  let prompt = '';

  try {
    CONFIG.PROFILE_MEMORY_ENABLED = false;
    CONFIG.WHAT_IF_ENABLED = false;
    CONFIG.DECISION_LOG_ENABLED = false;
    prompt = buildPrompt_('明天下午3點牙醫', null, [], null, 'test-group');
  } finally {
    CONFIG.PROFILE_MEMORY_ENABLED = oldProfile;
    CONFIG.WHAT_IF_ENABLED = oldWhatIf;
    CONFIG.DECISION_LOG_ENABLED = oldDecision;
  }

  assert_(prompt.indexOf('任務：判斷使用者訊息的意圖') !== -1, 'base prompt missing');
  assert_(prompt.indexOf('【家庭人物與別名】') === -1, 'profile context should be disabled');
}

// ---------------------------------------------------------------- What-if Calendar V1 tests

function testWhatIfV1SheetSchemas() {
  assert_(sheetHeaders_(FAMILY_PROFILE_SHEET).join('|') === FAMILY_PROFILE_HEADERS.join('|'),
    'family_profile schema mismatch');
  assert_(sheetHeaders_(ROUTINE_MODEL_SHEET).join('|') === ROUTINE_MODEL_HEADERS.join('|'),
    'routine_model schema mismatch');
  assert_(sheetHeaders_(PROFILE_MEMORY_SHEET).join('|') === PROFILE_MEMORY_HEADERS.join('|'),
    'profile_memory schema mismatch');
}

function testWhatIfV1BaselineMergesCalendarAndRoutine() {
  const groupId = 'test-whatif-v1';
  const start = new Date('2026-06-25T09:00:00+08:00');
  const end = new Date('2026-07-02T09:00:00+08:00');
  const baseline = buildSevenDayBaseline_({
    groupId: groupId,
    start: start,
    end: end,
    calendarEvents: [{
      eventId: 'cal-1',
      title: '[WHATIF_TEST] 大女兒看牙醫',
      start: '2026-06-26T16:00:00+08:00',
      end: '2026-06-26T17:00:00+08:00',
      location: '住家區',
      movable: true
    }],
    familyProfile: [{
      member_id: 'child_01',
      name: '孩子A',
      aliases_json: safeJsonStringify_(['大女兒']),
      requires_adult_companion: true
    }],
    routineModel: [{
      routine_id: 'work-father',
      title: '家長A工作',
      participant_ids_json: safeJsonStringify_(['father']),
      owner_id: 'father',
      weekday: 5,
      start_time: '08:30',
      end_time: '17:00',
      location: '市區',
      movable: false,
      needs_adult: false
    }]
  });

  assert_(baseline.calendarEvents.length === 1, 'calendar events missing from baseline');
  assert_(baseline.routineEvents.length === 1, 'routine events missing from baseline');
  assert_(baseline.events.length === 2, 'baseline should merge calendar and routine events');
  assert_(baseline.members[0].member_id === 'child_01', 'family member missing from baseline');
}

function testWhatIfV1GeneratesScoredVariableOptions() {
  const input = buildWhatIfV1Fixture_();
  const ranked = planWhatIfCalendarV1(input);

  assert_(ranked.ranked.length >= 2, 'should produce more than one feasible option');
  assert_(ranked.ranked.every((o) => o.cost && typeof o.cost.total === 'number'), 'cost required');
  assert_(ranked.best.optionId === ranked.ranked[0].optionId, 'best should be first ranked option');
  assert_(ranked.ranked.some((o) => o.moves && o.moves.length), 'move-event option missing');
  assert_(ranked.ranked.some((o) => o.leave && o.leave.hours > 0), 'leave option missing');
}

function testWhatIfV1EliminatesImmovableDirectMove() {
  const input = buildWhatIfV1Fixture_();
  input.baseline.events.push({
    source: 'routine',
    routineId: 'work-mother',
    title: '家長B工作',
    start: '2026-06-26T08:30:00+08:00',
    end: '2026-06-26T18:00:00+08:00',
    participantIds: ['mother'],
    ownerId: 'mother',
    location: '市區',
    movable: false
  });

  const options = removeImpossibleScenarios(generateWhatIfV1Scenarios_(input), [], input);
  assert_(!options.some((o) => (o.moves || []).some((m) => m.routineId === 'work-mother')),
    'immovable routine must not be directly moved');
}

function testWhatIfV1PreferenceBreaksCloseCostTie() {
  const input = buildWhatIfV1Fixture_();
  input.baseline.profile.preferences = [{
    canonicalValue: '平日下午新增小孩行程時，優先改日期，避免家長B請假'
  }];

  const ranked = planWhatIfCalendarV1(input);
  assert_(ranked.best && ranked.best.preferenceBoost > 0, 'active preference should affect ranking');
  assert_(ranked.recommendationReason.indexOf('避免家長B請假') !== -1,
    'recommendation reason should mention matching memory');
}

function testTc01CreateRoutesToWhatIfBeforeCalendarWrite() {
  const oldParse = parseWithLLM;
  const oldFindLast = findLastCalendarLog;
  const oldPending = getPendingConflict;
  const oldExamples = loadFewShotExamples;
  const oldProfiles = findFamilyProfilesByGroup;
  const oldRoutines = findRoutineModelsByGroup;
  const oldMemories = loadRelevantProfileMemories;
  const oldList = listEvents;
  const oldCreateDecision = createDecisionRecord;
  const oldAppendLog = appendLog;
  const oldReplyDecision = replyDecisionOptions;
  const oldCreateCalendar = createCalendarEvent;
  const oldResearch = runWebResearch;
  const oldCheckConflicts = checkConflicts;
  const oldReplyLine = replyLine;
  let createCount = 0;
  let decisionCount = 0;
  let repliedRanked = null;

  try {
    parseWithLLM = function () {
      return {
        intent: INTENTS.CREATE,
        event: {
          title: '家長A帶孩子A去住家區看牙醫',
          start: '2026-06-24T19:00:00+08:00',
          end: '2026-06-24T20:00:00+08:00'
        }
      };
    };
    findLastCalendarLog = function () { return null; };
    getPendingConflict = function () { return null; };
    loadFewShotExamples = function () { return []; };
    findFamilyProfilesByGroup = function () {
      return [{
        member_id: 'father',
        name: '家長A',
        aliases_json: safeJsonStringify_(['爸爸']),
        role: 'adult',
        requires_adult_companion: false
      }, {
        member_id: 'child_01',
        name: '孩子A',
        aliases_json: safeJsonStringify_(['妞妞']),
        role: 'child',
        requires_adult_companion: true
      }];
    };
    findRoutineModelsByGroup = function () { return []; };
    loadRelevantProfileMemories = function () { return []; };
    listEvents = function (start, end) {
      const startHour = new Date(start).getHours();
      if (startHour !== 0) return [];
      return [{
        eventId: 'whatif-test-family-clean',
        title: '[WHATIF_TEST] 家庭整理',
        start: '2026-06-24T19:00:00+08:00',
        end: '2026-06-24T20:00:00+08:00',
        location: '住家區'
      }];
    };
    createDecisionRecord = function () {
      decisionCount++;
      return 'DEC-TC01';
    };
    appendLog = function () {};
    replyDecisionOptions = function (replyToken, message, decisionId, ranked) {
      repliedRanked = ranked;
    };
    createCalendarEvent = function () {
      createCount++;
      return { title: 'should-not-create', eventId: 'created-too-early' };
    };
    checkConflicts = function () { return []; };
    replyLine = function () {};
    runWebResearch = function () {
      return { evidenceStatus: 'not_searched', results: [] };
    };

    handleTextMessage_({
      logId: 'log-tc01',
      groupId: 'group-tc01',
      userId: 'user-tc01',
      replyToken: 'reply-tc01',
      text: '這週三晚上七點，爸爸帶妞妞去住家區看牙醫一小時，原本可以移動的行程可以調整。'
    });
  } finally {
    parseWithLLM = oldParse;
    findLastCalendarLog = oldFindLast;
    getPendingConflict = oldPending;
    loadFewShotExamples = oldExamples;
    findFamilyProfilesByGroup = oldProfiles;
    findRoutineModelsByGroup = oldRoutines;
    loadRelevantProfileMemories = oldMemories;
    listEvents = oldList;
    createDecisionRecord = oldCreateDecision;
    appendLog = oldAppendLog;
    replyDecisionOptions = oldReplyDecision;
    createCalendarEvent = oldCreateCalendar;
    runWebResearch = oldResearch;
    checkConflicts = oldCheckConflicts;
    replyLine = oldReplyLine;
  }

  assert_(createCount === 0, 'TC-01 must not create Calendar event before user selects a plan');
  assert_(decisionCount === 1, 'TC-01 should create a decision record');
  assert_(!!repliedRanked, 'TC-01 should reply with What-if ranked options');
  const moveOption = (repliedRanked.ranked || []).filter((o) =>
    (o.moves || []).some((m) => m.from && m.from.title === '[WHATIF_TEST] 家庭整理'))[0];
  assert_(!!moveOption, 'TC-01 should include moving [WHATIF_TEST] 家庭整理');
  assert_(moveOption.cost.leaveHours === 0, 'TC-01 move option leave cost should be 0 hours');
  assert_(moveOption.cost.rearrangeCount === 1, 'TC-01 move option should have 1 rearrangement');
  assert_(moveOption.cost.cascadeCount === 0, 'TC-01 move option should have 0 cascade impacts');
  assert_(moveOption.cost.total === 1, 'TC-01 move option total cost should be 1');
}

function testExplicitWhatIfPrefixBypassesGeneralCreateRoute() {
  const oldParse = parseWithLLM;
  const oldFindLast = findLastCalendarLog;
  const oldPending = getPendingConflict;
  const oldExamples = loadFewShotExamples;
  const oldProfiles = findFamilyProfilesByGroup;
  const oldRoutines = findRoutineModelsByGroup;
  const oldMemories = loadRelevantProfileMemories;
  const oldList = listEvents;
  const oldCreateDecision = createDecisionRecord;
  const oldAppendLog = appendLog;
  const oldReplyDecision = replyDecisionOptions;
  const oldCreateCalendar = createCalendarEvent;
  const oldResearch = runWebResearch;
  const oldCreateHandler = INTENT_HANDLERS[INTENTS.CREATE];
  const oldConsoleLog = console.log;
  let createCount = 0;
  let decisionCount = 0;
  let generalCreateRouteCount = 0;
  let routeEnteredCount = 0;
  let replyMessage = '';
  let repliedRanked = null;
  let parsedText = '';

  try {
    console.log = function (message) {
      if (String(message) === 'WHATIF_ROUTE_ENTERED') routeEnteredCount++;
    };
    parseWithLLM = function (text) {
      parsedText = text;
      return {
        intent: INTENTS.CREATE,
        event: {
          title: '家長A帶孩子A去住家區看牙醫',
          start: '2026-06-24T19:00:00+08:00',
          end: '2026-06-24T20:00:00+08:00'
        }
      };
    };
    INTENT_HANDLERS[INTENTS.CREATE] = function () {
      generalCreateRouteCount++;
    };
    findLastCalendarLog = function () { return null; };
    getPendingConflict = function () { return null; };
    loadFewShotExamples = function () { return []; };
    findFamilyProfilesByGroup = function () {
      return [{
        member_id: 'father',
        name: '家長A',
        aliases_json: safeJsonStringify_(['爸爸']),
        role: 'adult',
        requires_adult_companion: false
      }, {
        member_id: 'child_01',
        name: '孩子A',
        aliases_json: safeJsonStringify_(['妞妞']),
        role: 'child',
        requires_adult_companion: true
      }];
    };
    findRoutineModelsByGroup = function () { return []; };
    loadRelevantProfileMemories = function () { return []; };
    listEvents = function () {
      return [{
        eventId: 'whatif-test-family-clean',
        title: '[WHATIF_TEST] 家庭整理',
        start: '2026-06-24T19:00:00+08:00',
        end: '2026-06-24T20:00:00+08:00',
        location: '住家區'
      }];
    };
    createDecisionRecord = function () {
      decisionCount++;
      return 'DEC-WHATIF-PREFIX';
    };
    appendLog = function () {};
    replyDecisionOptions = function (replyToken, message, decisionId, ranked) {
      replyMessage = message;
      repliedRanked = ranked;
    };
    createCalendarEvent = function () {
      createCount++;
      return { title: 'should-not-create', eventId: 'created-too-early' };
    };
    runWebResearch = function () {
      return { evidenceStatus: 'not_searched', results: [] };
    };

    handleTextMessage_({
      logId: 'log-whatif-prefix',
      groupId: 'group-tc01',
      userId: 'user-tc01',
      replyToken: 'reply-tc01',
      text: 'What-if：這週三晚上七點，爸爸帶妞妞去住家區看牙醫一小時。'
    });
  } finally {
    console.log = oldConsoleLog;
    parseWithLLM = oldParse;
    findLastCalendarLog = oldFindLast;
    getPendingConflict = oldPending;
    loadFewShotExamples = oldExamples;
    findFamilyProfilesByGroup = oldProfiles;
    findRoutineModelsByGroup = oldRoutines;
    loadRelevantProfileMemories = oldMemories;
    listEvents = oldList;
    createDecisionRecord = oldCreateDecision;
    appendLog = oldAppendLog;
    replyDecisionOptions = oldReplyDecision;
    createCalendarEvent = oldCreateCalendar;
    runWebResearch = oldResearch;
    INTENT_HANDLERS[INTENTS.CREATE] = oldCreateHandler;
  }

  assert_(routeEnteredCount === 1, 'explicit What-if route should log WHATIF_ROUTE_ENTERED');
  assert_(parsedText === '這週三晚上七點，爸爸帶妞妞去住家區看牙醫一小時。',
    'What-if prefix should be stripped before parsing');
  assert_(generalCreateRouteCount === 0, 'explicit What-if route must bypass general create-event route');
  assert_(createCount === 0, 'explicit What-if route must not create Calendar events before postback');
  assert_(decisionCount === 1, 'explicit What-if route should create a decision record');
  assert_(!!repliedRanked && (repliedRanked.ranked || []).length > 0, 'explicit What-if route should return options');
  assert_(replyMessage.indexOf('推薦') !== -1, 'explicit What-if reply should include recommendation');
}

function testTc01CorrectionMisparseRoutesToWhatIfPreflight() {
  const oldParse = parseWithLLM;
  const oldFindLast = findLastCalendarLog;
  const oldPending = getPendingConflict;
  const oldExamples = loadFewShotExamples;
  const oldProfiles = findFamilyProfilesByGroup;
  const oldRoutines = findRoutineModelsByGroup;
  const oldMemories = loadRelevantProfileMemories;
  const oldList = listEvents;
  const oldCreateDecision = createDecisionRecord;
  const oldAppendLog = appendLog;
  const oldReplyDecision = replyDecisionOptions;
  const oldCreateCalendar = createCalendarEvent;
  const oldUpdateCalendar = updateCalendarEvent;
  const oldMarkLog = markLogStatus;
  const oldAppendExample = appendExampleCandidate;
  const oldReflection = tryCreateReflection_;
  const oldProfileExtract = tryExtractProfileMemory_;
  const oldResearch = runWebResearch;
  const oldReplyLine = replyLine;
  const oldConsoleLog = console.log;
  let createCount = 0;
  let updateCount = 0;
  let decisionCount = 0;
  let whatIfPreflightCount = 0;
  let whatIfOptionsCount = 0;
  let routeUpdateCount = 0;
  let repliedRanked = null;
  let replyText = '';

  try {
    console.log = function (message) {
      if (String(message) === 'ROUTE_WHATIF_PREFLIGHT') whatIfPreflightCount++;
      if (String(message) === 'ROUTE_WHATIF_OPTIONS') whatIfOptionsCount++;
      if (String(message) === 'ROUTE_UPDATE') routeUpdateCount++;
    };
    parseWithLLM = function () {
      return {
        intent: INTENTS.CORRECTION,
        event: {
          title: '家長A帶孩子A去住家區看牙醫',
          start: '2026-06-24T19:00:00+08:00',
          end: '2026-06-24T20:00:00+08:00'
        }
      };
    };
    findLastCalendarLog = function () {
      return {
        logId: 'old-log',
        calendarEventId: 'old-event',
        rawText: '上一筆舊行程',
        geminiJson: '{}'
      };
    };
    getPendingConflict = function () { return null; };
    loadFewShotExamples = function () { return []; };
    findFamilyProfilesByGroup = function () {
      return [{
        member_id: 'father',
        name: '家長A',
        aliases_json: safeJsonStringify_(['爸爸']),
        role: 'adult',
        requires_adult_companion: false
      }, {
        member_id: 'child_01',
        name: '孩子A',
        aliases_json: safeJsonStringify_(['妞妞']),
        role: 'child',
        requires_adult_companion: true
      }];
    };
    findRoutineModelsByGroup = function () {
      return [{
        routine_id: 'routine-kids-bath',
        title: '小孩洗澡',
        participant_ids_json: safeJsonStringify_(['mother', 'child_01']),
        weekday: '3',
        start_time: '20:00',
        end_time: '20:30',
        location: '住家區',
        movable: false,
        event_type: 'care'
      }];
    };
    loadRelevantProfileMemories = function () { return []; };
    listEvents = function () {
      return [{
        eventId: 'whatif-test-family-clean',
        title: '[WHATIF_TEST] 家庭整理',
        start: '2026-06-24T19:00:00+08:00',
        end: '2026-06-24T20:00:00+08:00',
        location: '住家區'
      }];
    };
    createDecisionRecord = function () {
      decisionCount++;
      return 'DEC-TC01-MISPARSE';
    };
    appendLog = function () {};
    replyDecisionOptions = function (replyToken, message, decisionId, ranked) {
      replyText = message;
      repliedRanked = ranked;
    };
    createCalendarEvent = function () {
      createCount++;
      return { title: 'should-not-create', eventId: 'created-too-early' };
    };
    updateCalendarEvent = function () {
      updateCount++;
      return { title: 'should-not-update', eventId: 'updated-too-early' };
    };
    markLogStatus = function () {};
    appendExampleCandidate = function () {};
    tryCreateReflection_ = function () {};
    tryExtractProfileMemory_ = function () {};
    runWebResearch = function () {
      return { evidenceStatus: 'not_searched', results: [] };
    };
    replyLine = function (replyToken, message) {
      replyText = message;
    };

    handleTextMessage_({
      logId: 'log-tc01-misparse',
      groupId: 'group-tc01',
      userId: 'user-tc01',
      replyToken: 'reply-tc01',
      text: '這週三晚上七點，爸爸帶妞妞去住家區看牙醫一小時，原本可以移動的行程可以調整。'
    });
  } finally {
    console.log = oldConsoleLog;
    parseWithLLM = oldParse;
    findLastCalendarLog = oldFindLast;
    getPendingConflict = oldPending;
    loadFewShotExamples = oldExamples;
    findFamilyProfilesByGroup = oldProfiles;
    findRoutineModelsByGroup = oldRoutines;
    loadRelevantProfileMemories = oldMemories;
    listEvents = oldList;
    createDecisionRecord = oldCreateDecision;
    appendLog = oldAppendLog;
    replyDecisionOptions = oldReplyDecision;
    createCalendarEvent = oldCreateCalendar;
    updateCalendarEvent = oldUpdateCalendar;
    markLogStatus = oldMarkLog;
    appendExampleCandidate = oldAppendExample;
    tryCreateReflection_ = oldReflection;
    tryExtractProfileMemory_ = oldProfileExtract;
    runWebResearch = oldResearch;
    replyLine = oldReplyLine;
  }

  assert_(routeUpdateCount === 0, 'TC-01 misparse must not enter update/correction route');
  assert_(whatIfPreflightCount === 1, 'TC-01 misparse should enter What-if preflight');
  assert_(whatIfOptionsCount === 1, 'TC-01 misparse should return What-if options');
  assert_(createCount === 0, 'TC-01 misparse must not create Calendar event before selection');
  assert_(updateCount === 0, 'TC-01 misparse must not update Calendar event');
  assert_(decisionCount === 1, 'TC-01 misparse should create decision record');
  assert_(!!repliedRanked && (repliedRanked.ranked || []).length <= 3, 'TC-01 misparse should show compact options');
  assert_((repliedRanked.ranked || []).some((o) => (o.moves || []).some((m) =>
    m.from && m.from.title === '[WHATIF_TEST] 家庭整理')), 'TC-01 misparse should include moving 家庭整理');
  assert_(replyText.indexOf('已加入行事曆') === -1, 'TC-01 misparse must not reply added');
  assert_(replyText.indexOf('已修正行程') === -1, 'TC-01 misparse must not reply corrected');
}

function testTc01PrunesUnresolvedBaselineConflicts() {
  const input = buildTc01PruningFixture_();
  const options = generateWhatIfV1Scenarios_(input);
  const possible = removeImpossibleScenarios(options);
  const ranked = rankScenarios(possible, { baseline: input.baseline, demand: input.demand });

  assert_(!possible.some((o) => o.type === 'AS_PROPOSED'),
    'AS_PROPOSED must be pruned when it overlaps [WHATIF_TEST] 家庭整理');
  assert_(!possible.some((o) => o.newEvent.start === '2026-06-24T20:00:00+08:00'),
    '20:00-21:00 must be pruned because it overlaps 小孩洗澡');
  assert_(!possible.some((o) => o.newEvent.start === '2026-06-24T21:00:00+08:00'),
    '21:00-22:00 must be pruned because it overlaps 小孩就寢');
  assert_(!possible.some((o) => /2026-06-(25|26)T09:00:00/.test(o.newEvent.start)),
    'Thursday/Friday 09:00 options must be pruned because they overlap work and school');
  const moveOption = possible.filter((o) => (o.moves || []).some((m) =>
    m.from && m.from.title === '[WHATIF_TEST] 家庭整理'))[0];
  assert_(!!moveOption, 'must keep a feasible option that moves [WHATIF_TEST] 家庭整理');
  assert_(moveOption.cost.leaveHours === 0, 'move option leave cost should be 0');
  assert_(moveOption.cost.rearrangeCount === 1, 'move option rearrange count should be 1');
  assert_(moveOption.cost.cascadeCount === 0, 'move option cascade count should be 0');
  assert_(moveOption.cost.total === 1, 'move option total cost should be 1');
  assert_(ranked.best && ranked.best.type === 'MOVE_EVENT', 'move option should be recommended for TC-01 fixture');
}

function testTc01FinalScheduleRejectsMovedAndShiftedOverlaps() {
  const input = buildTc01PruningFixture_();
  const badMove = finalizeScenarioOption_({
    optionId: 'Z',
    type: 'MOVE_EVENT',
    title: 'bad move',
    action: { kind: 'apply_plan', event: input.eventDraft, moves: [] },
    newEvent: buildPlannedNewEvent_(input.eventDraft, input.demand, 'father'),
    moves: [{
      from: input.baseline.events[0],
      to: Object.assign({}, input.baseline.events[0], {
        start: '2026-06-24T21:00:00+08:00',
        end: '2026-06-24T22:00:00+08:00'
      })
    }],
    reassignments: [],
    leave: { hours: 0 },
    cascadeCount: 0,
    assumptions: [],
    consequences: [],
    uncertainty: 'medium'
  }, 25, input.baseline, input.demand);
  const badShift = finalizeScenarioOption_({
    optionId: 'Y',
    type: 'TIME_SHIFT',
    title: 'bad shift',
    action: { kind: 'apply_plan', event: input.eventDraft, moves: [] },
    newEvent: buildPlannedNewEvent_(Object.assign({}, input.eventDraft, {
      start: '2026-06-24T20:00:00+08:00',
      end: '2026-06-24T21:00:00+08:00'
    }), input.demand, 'father'),
    moves: [],
    reassignments: [],
    leave: { hours: 0 },
    cascadeCount: 0,
    assumptions: [],
    consequences: [],
    uncertainty: 'medium'
  }, 24, input.baseline, input.demand);
  const options = generateWhatIfV1Scenarios_(input);
  const possible = removeImpossibleScenarios(options);
  const ranked = limitRankedForLine_(rankScenarios(possible, {
    baseline: input.baseline,
    demand: input.demand
  }));

  assert_(firstFinalScheduleHardRejection_(badMove, input.baseline, input.demand),
    'moving 家庭整理 to 21:00-22:00 must be rejected because mother overlaps bedtime');
  assert_(firstFinalScheduleHardRejection_(badShift, input.baseline, input.demand),
    'moving dental visit to 20:00-21:00 must be rejected because child_01 overlaps bath');
  assert_(!possible.some((o) => o.type === 'AS_PROPOSED'),
    'direct 19:00-20:00 overlap with 家庭整理 must be rejected');
  assert_(!possible.some((o) => (o.moves || []).some((m) =>
    m.from && m.from.title === '[WHATIF_TEST] 家庭整理' &&
    m.to && m.to.start === '2026-06-24T21:00:00+08:00')),
    'generated move option must not keep 家庭整理 at 21:00-22:00');
  assert_(!possible.some((o) => o.newEvent && o.newEvent.start === '2026-06-24T20:00:00+08:00'),
    'generated time-shift option must not keep dental visit at 20:00-21:00');
  assert_((ranked.ranked || []).length <= possible.length,
    'LINE ranking must not add filler options after pruning');
}

function testDecisionReplyShowsOnlyThreeCompactOptions() {
  const input = buildTc01PruningFixture_();
  const ranked = rankScenarios(removeImpossibleScenarios(generateWhatIfV1Scenarios_(input)), {
    baseline: input.baseline,
    demand: input.demand
  });
  const message = buildDecisionReply_('DEC-SHOULD-NOT-SHOW', limitRankedForLine_(ranked));
  const lines = message.split('\n');
  const optionLines = lines.filter((line) => /^[ABC](\s|｜)/.test(line));

  assert_(optionLines.length <= 3, 'LINE reply should show at most three options');
  assert_(optionLines[0].indexOf('A 推薦') === 0, 'first option should be A 推薦');
  assert_(optionLines.every((line) => line.length <= 80), 'each compact option should fit on one short line');
  assert_(message.indexOf('decisionId') === -1, 'LINE reply must not show decisionId');
  assert_(message.indexOf('總分') === -1, 'LINE reply must not show score details');
  assert_(message.indexOf('主要代價') === -1, 'LINE reply must not show long main-cost text');
  assert_(!/[D-Z](\s|｜)/.test(message), 'LINE reply must not show more than A/B/C options');
}

function buildTc01PruningFixture_() {
  const baseline = {
    groupId: 'group-tc01',
    members: [
      { member_id: 'father', name: '家長A', role: 'adult', requires_adult_companion: false },
      { member_id: 'mother', name: '家長B', role: 'adult', requires_adult_companion: false },
      { member_id: 'child_01', name: '孩子A', role: 'child', requires_adult_companion: true },
      { member_id: 'child_02', name: '孩子B', role: 'infant', requires_adult_companion: true }
    ],
    profile: { people: [], aliases: [], constraints: [], preferences: [] },
    events: [{
      source: 'calendar',
      eventId: 'family-clean',
      title: '[WHATIF_TEST] 家庭整理',
      start: '2026-06-24T19:00:00+08:00',
      end: '2026-06-24T20:00:00+08:00',
      participantIds: ['father', 'mother'],
      ownerId: 'father',
      location: '住家區',
      movable: true,
      eventType: 'test'
    }, {
      source: 'routine',
      routineId: 'routine-father-work',
      title: '家長A工作',
      start: '2026-06-25T08:30:00+08:00',
      end: '2026-06-25T17:00:00+08:00',
      participantIds: ['father'],
      ownerId: 'father',
      location: '市區',
      movable: false,
      eventType: 'work'
    }, {
      source: 'routine',
      routineId: 'routine-child-school',
      title: '孩子A上學',
      start: '2026-06-25T08:20:00+08:00',
      end: '2026-06-25T18:00:00+08:00',
      participantIds: ['child_01'],
      ownerId: '',
      location: '市區',
      movable: false,
      eventType: 'school'
    }, {
      source: 'routine',
      routineId: 'routine-father-work-fri',
      title: '家長A工作',
      start: '2026-06-26T08:30:00+08:00',
      end: '2026-06-26T17:00:00+08:00',
      participantIds: ['father'],
      ownerId: 'father',
      location: '市區',
      movable: false,
      eventType: 'work'
    }, {
      source: 'routine',
      routineId: 'routine-child-school-fri',
      title: '孩子A上學',
      start: '2026-06-26T08:20:00+08:00',
      end: '2026-06-26T18:00:00+08:00',
      participantIds: ['child_01'],
      ownerId: '',
      location: '市區',
      movable: false,
      eventType: 'school'
    }, {
      source: 'routine',
      routineId: 'routine-kids-bath',
      title: '小孩洗澡',
      start: '2026-06-24T20:00:00+08:00',
      end: '2026-06-24T20:30:00+08:00',
      participantIds: ['mother', 'child_01', 'child_02'],
      ownerId: 'mother',
      location: '住家區',
      movable: false,
      eventType: 'care'
    }, {
      source: 'routine',
      routineId: 'routine-kids-bedtime',
      title: '小孩就寢',
      start: '2026-06-24T21:00:00+08:00',
      end: '2026-06-24T21:30:00+08:00',
      participantIds: ['mother', 'child_01', 'child_02'],
      ownerId: 'mother',
      location: '住家區',
      movable: false,
      eventType: 'care'
    }],
    calendarEvents: [],
    routineEvents: []
  };
  const eventDraft = {
    title: '家長A帶孩子A去住家區看牙醫',
    start: '2026-06-24T19:00:00+08:00',
    end: '2026-06-24T20:00:00+08:00',
    location: '住家區'
  };
  return {
    groupId: 'group-tc01',
    eventDraft: eventDraft,
    demand: {
      title: eventDraft.title,
      requiredParticipantIds: ['father', 'child_01'],
      location: '住家區',
      durationMinutes: 60,
      dateRangeStart: '2026-06-24T00:00:00+08:00',
      dateRangeEnd: '2026-06-30T23:59:59+08:00'
    },
    baseline: baseline
  };
}

function buildWhatIfV1Fixture_() {
  return {
    groupId: 'test-whatif-v1',
    eventDraft: {
      title: '大女兒復健',
      start: '2026-06-26T16:00:00+08:00',
      end: '2026-06-26T17:00:00+08:00',
      location: '住家區'
    },
    demand: {
      title: '大女兒復健',
      requiredParticipantIds: ['child_01'],
      location: '住家區',
      durationMinutes: 60,
      dateRangeStart: '2026-06-26T00:00:00+08:00',
      dateRangeEnd: '2026-07-02T23:59:59+08:00'
    },
    baseline: {
      members: [
        { member_id: 'child_01', name: '孩子A', requires_adult_companion: true },
        { member_id: 'father', name: '家長A', role: 'adult', work_location: '市區' },
        { member_id: 'mother', name: '家長B', role: 'adult', work_location: '市區' }
      ],
      profile: { people: [], aliases: [], constraints: [], preferences: [] },
      events: [{
        source: 'calendar',
        eventId: 'cal-1',
        title: '[WHATIF_TEST] 大女兒積木課',
        start: '2026-06-26T16:00:00+08:00',
        end: '2026-06-26T17:00:00+08:00',
        participantIds: ['child_01', 'mother'],
        ownerId: 'mother',
        location: '住家區',
        movable: true
      }, {
        source: 'routine',
        routineId: 'work-father',
        title: '家長A工作',
        start: '2026-06-26T08:30:00+08:00',
        end: '2026-06-26T17:00:00+08:00',
        participantIds: ['father'],
        ownerId: 'father',
        location: '市區',
        movable: false
      }],
      calendarEvents: [],
      routineEvents: []
    }
  };
}
