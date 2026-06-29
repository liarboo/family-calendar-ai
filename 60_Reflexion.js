/**
 * 60_Reflexion.gs — Reflexion experiment mode
 *
 * 關閉時不讀 memory、不寫 reflection_memory。
 */

function buildReflectionMemoryText_(groupId) {
  if (!CONFIG.REFLEXION_ENABLED || !groupId) return '';

  const memories = loadActiveReflectionMemory(groupId, CONFIG.MEMORY_LIMIT);
  if (!memories.length) return '';

  return [
    '',
    '【自動反思記憶 Reflexion Memory】',
    '以下是本家庭過去失敗後自動產生的反思記憶。請只在相關時使用，不相關時忽略。',
    '每條記憶代表過去一次錯誤後的修正策略。',
    '',
    '只讀：',
    '- 同 groupId',
    '- memoryStatus=active',
    '- reflectionText 非空',
    '- 最多 MEMORY_LIMIT 筆',
    '',
    '若有【待處理衝突】，pending conflict 優先於 memory。',
    memories.map((m, i) => (i + 1) + '. ' + m.reflectionText).join('\n')
  ].join('\n');
}

function evaluateLogForReflection(record) {
  if (!record) return { shouldReflect: false, reason: 'empty_record' };
  if ([STATUS.PENDING, STATUS.SKIPPED, STATUS.IGNORED].indexOf(record.status) !== -1) {
    return { shouldReflect: false, reason: record.status };
  }
  if (record.status === STATUS.CORRECTED) {
    return { shouldReflect: true, reason: 'corrected' };
  }
  if (record.status === STATUS.ERROR) {
    const message = String(record.errorMessage || '');
    return {
      shouldReflect: true,
      reason: 'error',
      jsonError: message.indexOf('非合法 JSON') !== -1,
      calendarApiError: /Calendar|GOOGLE_CALENDAR|行程/.test(message)
    };
  }
  return { shouldReflect: false, reason: record.status || 'not_error_or_corrected' };
}

function generateReflection_(trajectory, evaluatorResult) {
  const prompt = [
    '你是家庭行事曆 bot 的自我反思模組。',
    '請根據這次錯誤或修正，產生一條可放進下次 prompt 的短反思記憶。',
    '只輸出 JSON：{"reflectionText":"一句繁體中文策略"}，不要 markdown。',
    '',
    'trajectory:',
    JSON.stringify(trajectory),
    '',
    'evaluator:',
    JSON.stringify(evaluatorResult)
  ].join('\n');
  const parsed = parseJsonLoose_(callLlmRawWithFallback_(prompt).text);
  return String(parsed.reflectionText || '').trim().slice(0, 1000);
}

function maybeCreateReflectionMemory_(record, triggerType) {
  if (!CONFIG.REFLEXION_ENABLED) return logReflectionSkip_('disabled');
  if (!reflectionTriggerEnabled_(triggerType)) return logReflectionSkip_('trigger_disabled:' + triggerType);
  if (!record || !record.logId) return logReflectionSkip_('missing_log_id');

  const evaluatorResult = evaluateLogForReflection(record);
  if (!evaluatorResult.shouldReflect) return logReflectionSkip_('not_reflect:' + evaluatorResult.reason);
  if (reflectionMemoryExists(record.logId)) return logReflectionSkip_('duplicate:' + record.logId);

  const trajectory = {
    logId: record.logId,
    groupId: record.groupId,
    rawText: record.rawText,
    intent: record.intent,
    parsedJson: record.geminiJson,
    finalJson: record.finalJson || record.correctedJson || '',
    status: record.status,
    errorMessage: record.errorMessage || '',
    correctionText: record.correctionText || ''
  };
  const reflectionText = generateReflection_(trajectory, evaluatorResult);
  if (!reflectionText) return logReflectionSkip_('empty_reflection');

  return appendReflectionMemory({
    groupId: record.groupId,
    sourceLogId: record.logId,
    triggerType: triggerType,
    rawText: record.rawText,
    trajectoryJson: JSON.stringify(trajectory),
    evaluatorResult: JSON.stringify(evaluatorResult),
    reflectionText: reflectionText,
    memoryStatus: CONFIG.AUTO_MEMORY_ACTIVE ? 'active' : 'disabled'
  });
}

function logReflectionSkip_(reason) {
  console.log('Reflection skipped: ' + reason);
  return null;
}

function reflectionTriggerType_(record) {
  const message = String((record && record.errorMessage) || '');
  if (message.indexOf('非合法 JSON') !== -1) return 'json_error';
  if (/Calendar|GOOGLE_CALENDAR|行程/.test(message)) return 'calendar_api_error';
  return 'error';
}

function reflectionTriggerEnabled_(triggerType) {
  if (triggerType === 'corrected') return CONFIG.REFLECTION_ON_CORRECTION;
  if (triggerType === 'json_error') return CONFIG.REFLECTION_ON_JSON_ERROR;
  if (triggerType === 'calendar_api_error') return CONFIG.REFLECTION_ON_CALENDAR_API_ERROR;
  return CONFIG.REFLECTION_ON_ERROR;
}
