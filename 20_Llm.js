/**
 * 20_Llm.gs — 語意解析（雙供應商：OpenAI / Gemini）
 *
 * 職責：自然語言 → { intent, event }
 * 用 Script Properties 的 LLM_PROVIDER 切換供應商（openai / gemini），
 * 兩邊共用同一份 prompt、重試邏輯與輸出驗證，切換不影響其他模組。
 */

function parseWithLLM(text, lastEvent, examples, pending, groupId, userId) {
  const prompt = buildPrompt_(text, lastEvent, examples, pending, groupId, userId);
  const result = callLlmJsonWithFallback_(prompt);
  const parsed = result.parsed;

  parsed._llmProvider = result.provider;
  if (result.primaryError) parsed._primaryError = result.primaryError;
  return parsed;
}

function callLlmJsonWithFallback_(prompt) {
  const primary = CONFIG.LLM_PROVIDER === 'openai' ? 'openai' : 'gemini';
  try {
    return {
      parsed: parseAndValidateLlmJson_(callLlmRaw_(primary, prompt)),
      provider: primary,
      primaryError: ''
    };
  } catch (err) {
    if (primary !== 'openai' || !CONFIG.LLM_FALLBACK_ENABLED) throw err;
    const primaryError = shortError_(err);
    try {
      return {
        parsed: parseAndValidateLlmJson_(callGemini_(prompt)),
        provider: 'gemini',
        primaryError: primaryError
      };
    } catch (fallbackErr) {
      throw new Error('OpenAI 與 Gemini 皆失敗：OpenAI=' + primaryError +
        '；Gemini=' + shortError_(fallbackErr));
    }
  }
}

function callLlmRaw_(provider, prompt) {
  return provider === 'openai' ? callOpenAI_(prompt) : callGemini_(prompt);
}

function parseAndValidateLlmJson_(raw) {
  const parsed = parseJsonLoose_(raw);
  const validIntents = Object.keys(INTENTS).map((k) => INTENTS[k]);
  if (validIntents.indexOf(parsed.intent) === -1) {
    throw new Error('LLM 回傳未知 intent：' + JSON.stringify(parsed.intent));
  }
  return parsed;
}

function callLlmRawWithFallback_(prompt) {
  const primary = CONFIG.LLM_PROVIDER === 'openai' ? 'openai' : 'gemini';
  try {
    return { text: callLlmRaw_(primary, prompt), provider: primary, primaryError: '' };
  } catch (err) {
    if (primary !== 'openai' || !CONFIG.LLM_FALLBACK_ENABLED) throw err;
    try {
      return { text: callGemini_(prompt), provider: 'gemini', primaryError: shortError_(err) };
    } catch (fallbackErr) {
      throw new Error('OpenAI 與 Gemini 皆失敗：OpenAI=' + shortError_(err) +
        '；Gemini=' + shortError_(fallbackErr));
    }
  }
}

function shortError_(err) {
  return redactSecrets_(String((err && err.message) || err)).slice(0, 300);
}

function redactSecrets_(text) {
  return String(text)
    .replace(/key=[^&\s]+/g, 'key=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}

// ---------------------------------------------------------------- OpenAI

function callOpenAI_(prompt) {
  if (!CONFIG.OPENAI_API_KEY) throw new Error('未設定 OPENAI_API_KEY');

  const res = fetchWithRetry_('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.OPENAI_API_KEY },
    payload: JSON.stringify({
      model: CONFIG.OPENAI_MODEL,
      reasoning_effort: 'low',                    // 解析任務不需深度推理，降低延遲與成本
      response_format: { type: 'json_object' },   // 強制純 JSON 輸出
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('OpenAI API failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  const raw = data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('OpenAI 回應為空');
  return raw;
}

// ---------------------------------------------------------------- Gemini

function callGemini_(prompt) {
  if (!CONFIG.GEMINI_API_KEY) throw new Error('未設定 GEMINI_API_KEY');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL + ':generateContent?key=' + CONFIG.GEMINI_API_KEY;

  const res = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json'
      }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini API failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  const candidates = data.candidates || [];
  const parts = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
  const raw = parts[0] && parts[0].text;
  if (!raw) throw new Error('Gemini 回應為空');
  return raw;
}

// ---------------------------------------------------------------- 共用：重試

/** 429（限流）/ 503（過載）視為暫時性錯誤，最多重試 3 次，間隔 1s → 2s → 4s */
function fetchWithRetry_(url, options) {
  let res = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) Utilities.sleep(1000 * Math.pow(2, attempt - 1));
    res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code !== 503 && code !== 429) break;
    console.log('LLM API ' + code + '，第 ' + (attempt + 1) + ' 次嘗試失敗，準備重試');
  }
  return res;
}

// ---------------------------------------------------------------- prompt

function buildPrompt_(text, lastEvent, examples, pending, groupId, userId) {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd (EEEE) HH:mm');
  const lastEventText = lastEvent
    ? '原句：' + lastEvent.rawText + '\n結果：' + lastEvent.finalJson
    : '（無）';
  const context = buildPromptContext({ groupId: groupId, userId: userId, rawText: text, examples: examples });
  const profileText = buildProfilePromptText_(context.profile);
  const exampleText = context.examples.length ? context.examples.join('\n\n') : '（無）';
  const memoryText = buildReflectionPromptText_(context.reflections);

  // 衝突等待狀態：有 pending 時，這段上下文讓 LLM 能解讀使用者的決定
  const pendingText = pending ? [
    '',
    '【待處理衝突】使用者剛才要建立的新行程與現有行程衝突，正在等待使用者決定處理方式：',
    '新行程：' + JSON.stringify(pending.newEvent),
    '衝突的現有行程（編號從 1 開始）：',
    pending.conflicts.map((c, i) => (i + 1) + '. ' + JSON.stringify(c)).join('\n'),
    '若這句話是在回答如何處理（例如「1」「把舊的改到4點」「新的改晚上」「都保留」「取消」），',
    'intent 必須是 resolve，格式：',
    '{"intent":"resolve","resolution":{"action":"...","targetIndex":1,"event":{...}}}',
    '- action 只能是：move_existing（改現有行程的時間）/ reschedule_new（改新行程的時間）/ keep_both（兩個都保留）/ cancel（放棄建立）',
    '- move_existing：event 填「現有行程」改後的完整內容（title 沿用現有行程），targetIndex 指出是哪一筆。',
    '- reschedule_new：event 填「新行程」改後的完整內容。',
    '- 使用者沒講具體新時間時，event 給 null。',
    '- 若這句話與衝突處理無關，依一般規則判斷 intent。'
  ].join('\n') : '';

  // resolve 這個 intent 只在有等待狀態時才讓 LLM 知道，避免誤用
  const resolveIntentLine = pending
    ? '- resolve：回答待處理衝突的處理方式（見下方【待處理衝突】）\n'
    : '';

  return [
    '你是家庭行事曆助理。現在時間是 ' + today + '，時區 ' + CONFIG.TIMEZONE + '。',
    '',
    '任務：判斷使用者訊息的意圖（intent），並輸出對應 JSON。',
    'intent 只能是以下其中之一：',
    '- create：要新增行程（例：明天下午3點帶女兒看牙醫）',
    '- correction：在修正「最近一筆已建立的行程」（例：不是明天是週五／改成4點／時間改早上）',
    '- query：查詢行程或詢問是否有空（例：明天有什麼行程、週六有空嗎）',
    '- update：要修改某個指定的舊行程（不是最近剛建立的那筆）',
    '- delete：要取消某個行程',
    resolveIntentLine + '- none：與行程無關的閒聊或一般訊息',
    '',
    '輸出規則：',
    '1. 只回傳 JSON，不要 markdown，不要解釋。',
    '2. create / correction 格式：{"intent":"...","event":{"title":"...","start":"YYYY-MM-DDTHH:mm:ss+08:00","end":"YYYY-MM-DDTHH:mm:ss+08:00"}}',
    '   correction 要輸出「修正後的最終結果」，使用者沒提到要改的欄位，沿用原行程的值。',
    '   沒講結束時間時，預設 ' + CONFIG.DEFAULT_DURATION_MINUTES + ' 分鐘。',
    '3. query 格式：{"intent":"query","range":{"start":"YYYY-MM-DDTHH:mm:ss+08:00","end":"YYYY-MM-DDTHH:mm:ss+08:00"}}',
    '   「明天有什麼行程」→ 明天 00:00 到後天 00:00；「週六有空嗎」→ 該日整天；',
    '   「這週有什麼行程」→ 本週一 00:00 到下週一 00:00。',
    '4. intent 為 none / update / delete 時，event 給 null。',
    pendingText,
    profileText,
    memoryText,
    '',
    '最近一筆已建立的行程（判斷是否為 correction、以及沿用欄位時參考）：',
    lastEventText,
    '',
    '【過去正確解析案例】',
    exampleText,
    '',
    '使用者訊息：' + text
  ].join('\n');
}

function buildPromptContext(input) {
  const groupId = input.groupId || '';
  return {
    profile: CONFIG.PROFILE_MEMORY_ENABLED ? buildFamilyProfileSnapshot(groupId) :
      { people: [], aliases: [], constraints: [], preferences: [] },
    examples: input.examples || loadFewShotExamples(),
    reflections: CONFIG.REFLEXION_ENABLED ? loadActiveReflectionMemory(groupId, CONFIG.MEMORY_LIMIT) : []
  };
}

function buildProfilePromptText_(profile) {
  if (!CONFIG.PROFILE_MEMORY_ENABLED) return '';
  const lines = [];
  if ((profile.aliases || []).length) {
    lines.push('人物與別名：');
    profile.aliases.forEach((p) => {
      lines.push('- ' + p.canonicalValue + '：' + (p.variants || []).join('、'));
    });
  }
  if ((profile.constraints || []).length) {
    lines.push('限制：');
    profile.constraints.forEach((p) => lines.push('- ' + p.canonicalValue));
  }
  if ((profile.preferences || []).length) {
    lines.push('偏好：');
    profile.preferences.forEach((p) => lines.push('- ' + p.canonicalValue));
  }
  if (!lines.length) return '';
  return ['', '【家庭人物與別名】', '只使用同 groupId 的 active profile memory。', lines.join('\n')].join('\n');
}

function buildReflectionPromptText_(memories) {
  if (!CONFIG.REFLEXION_ENABLED || !memories.length) return '';
  return [
    '',
    '【下次應遵守的反思規則】',
    '以下是本家庭過去失敗後自動產生的反思記憶。請只在相關時使用，不相關時忽略。',
    memories.map((m, i) => (i + 1) + '. ' + m.reflectionText).join('\n')
  ].join('\n');
}

// ---------------------------------------------------------------- 驗證

/** 清掉可能殘留的 markdown 圍欄後 parse */
function parseJsonLoose_(raw) {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('LLM 回傳非合法 JSON：' + cleaned.slice(0, 200));
  }
}

/**
 * 驗證並正規化 event。
 * 回傳 { title: string, start: Date, end: Date }，任何不合法直接丟錯，
 * 由最外層 catch 回覆使用者並記錄 error。
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('LLM 未回傳 event');

  const title = String(event.title || '').trim();
  if (!title) throw new Error('event 缺少 title');

  const start = new Date(event.start);
  if (isNaN(start.getTime())) throw new Error('start 不是合法時間：' + event.start);

  let end = event.end ? new Date(event.end) : null;
  if (!end || isNaN(end.getTime())) {
    end = new Date(start.getTime() + CONFIG.DEFAULT_DURATION_MINUTES * 60 * 1000);
  }
  if (end <= start) throw new Error('end 必須晚於 start');

  return { title: title, start: start, end: end };
}

/** 驗證查詢的時間範圍，回傳 { start: Date, end: Date } */
function validateRange(range) {
  if (!range || typeof range !== 'object') throw new Error('LLM 未回傳查詢範圍');
  const start = new Date(range.start);
  const end = new Date(range.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('查詢範圍不是合法時間：' + JSON.stringify(range));
  }
  if (end <= start) throw new Error('查詢範圍的 end 必須晚於 start');
  return { start: start, end: end };
}
