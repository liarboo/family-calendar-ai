/**
 * 10_Main.gs — 進入點與意圖路由
 *
 * 流程：
 *   doPost → 驗章 → 取出文字訊息 → 組 context
 *     → 讀取對話狀態（最近行程、待處理衝突、學習案例）
 *     → LLM 解析 → 依 intent 分流到對應 handler
 *     → handler 負責：執行動作 → 寫 learning_log → 回覆 LINE
 *
 * AI loop 的核心在「待處理衝突」：
 *   偵測衝突 → 暫停、向人類提問、記住等待狀態（pending）
 *   → 下一句話帶著 pending 上下文解析 → 人類的決定被執行並記錄
 *   → log 以 relatedLogId 串成完整決策鏈，成為日後可挖掘的偏好資料。
 */

function doPost(e) {
  let ctx = null;
  try {
    const wrapper = JSON.parse(e.postData.contents);

    if (CONFIG.VERIFY_SIGNATURE && !verifyLineSignature(wrapper.body, wrapper.signature)) {
      console.log('簽章驗證失敗。wrapper 欄位：' + Object.keys(wrapper).join(', ') +
        '；signature 存在：' + !!wrapper.signature);
      return jsonOut({ status: 'invalid_signature' });
    }

    const payload = JSON.parse(wrapper.body);
    const event = (payload.events || [])[0];
    if (isPostbackEvent_(event)) {
      ctx = buildContextFromSource_(event.source || {});
      handlePostbackEvent_(ctx, event);
      return jsonOut({ status: 'ok' });
    }
    if (!isTextMessageEvent_(event)) return jsonOut({ status: 'ignored' });

    ctx = buildContext_(event);
    handleTextMessage_(ctx);
    return jsonOut({ status: 'ok' });

  } catch (err) {
    handleFatalError_(ctx, err);
    return jsonOut({ status: 'error', message: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------- 路由表

const INTENT_HANDLERS = {
  [INTENTS.CREATE]: handleCreate_,
  [INTENTS.CORRECTION]: handleCorrection_,
  [INTENTS.QUERY]: handleQuery_,
  [INTENTS.RESOLVE]: handleResolve_,
  [INTENTS.UPDATE]: handleNotImplemented_,  // TODO(Phase 4)：修改指定行程
  [INTENTS.DELETE]: handleNotImplemented_,  // TODO(Phase 4)：取消行程
  [INTENTS.NONE]: handleNone_
};

// ---------------------------------------------------------------- 主處理

function handleTextMessage_(ctx) {
  const whatIfCommand = parseWhatIfCommand_(ctx.text);
  if (whatIfCommand.matched) {
    console.log('WHATIF_ROUTE_ENTERED');
    handleWhatIfCommand_(ctx, whatIfCommand.text);
    return;
  }

  if (tryHandleDecisionFeedback_(ctx)) return;

  // 對話狀態：這三樣東西構成 LLM 每次解析時的「記憶」
  const lastEvent = findLastCalendarLog(ctx.groupId);   // 修正功能的上下文
  const pending = getPendingConflict(ctx.groupId);      // 衝突迴圈的等待狀態
  const examples = loadFewShotExamples();               // 人工審核過的學習案例

  let parsed = parseWithLLM(ctx.text, lastEvent, examples, pending, ctx.groupId, ctx.userId);
  parsed = normalizeParsedRoute_(ctx, parsed, lastEvent, pending);
  ctx.intent = parsed.intent;
  ctx.geminiJson = JSON.stringify(parsed);

  const handler = INTENT_HANDLERS[parsed.intent] || handleNone_;
  handler(ctx, parsed, lastEvent, pending);
}

// ---------------------------------------------------------------- handlers

/** 新增行程（含衝突檢查：有衝突時不直接建立，改為提問並進入等待狀態） */
function handleCreate_(ctx, parsed) {
  console.log('ROUTE_CREATE');
  const ev = normalizeEventEntities(ctx.groupId, validateEvent(parsed.event));
  const eventDraft = toIsoEvent(ev);
  const baselineStart = startOfDay_(ev.start);
  const baselineEnd = new Date(baselineStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const baseline = buildSevenDayBaseline_({
    groupId: ctx.groupId,
    start: baselineStart,
    end: baselineEnd
  });
  const demand = buildWhatIfDemand_(eventDraft, ctx.groupId);
  const preliminaryOptions = CONFIG.WHAT_IF_ENABLED && CONFIG.DECISION_LOG_ENABLED ?
    generateWhatIfV1Scenarios_({
      groupId: ctx.groupId,
      eventDraft: eventDraft,
      demand: demand,
      baseline: baseline
    }) : [];
  const hasWhatIfConflict = preliminaryOptions.some((o) => o.type === 'AS_PROPOSED' && o.hardConflict);
  const hardConflicts = CONFIG.CONFLICT_CHECK ? detectCalendarConflicts(ev, { groupId: ctx.groupId })
    .filter((c) => c.severity === 'hard') : [];

  if ((hardConflicts.length > 0 || hasWhatIfConflict) && CONFIG.WHAT_IF_ENABLED && CONFIG.DECISION_LOG_ENABLED) {
    console.log('ROUTE_WHATIF_PREFLIGHT');
    replyWhatIfDecision_(ctx, ev, {
      eventDraft: eventDraft,
      hardConflicts: hardConflicts,
      baseline: baseline,
      demand: demand,
      preliminaryOptions: preliminaryOptions,
      reason: 'hard conflict; decision required'
    });
    return;
  }

  const conflicts = CONFIG.CONFLICT_CHECK ? checkConflicts(ev) : [];

  if (conflicts.length > 0) {
    savePendingConflict(ctx.groupId, {
      logId: ctx.logId,
      newEvent: toIsoEvent(ev),
      conflicts: conflicts
    });
    appendLog(baseLog_(ctx, {
      finalJson: JSON.stringify(toIsoEvent(ev)),
      status: STATUS.PENDING
    }));
    replyLine(ctx.replyToken, buildConflictMessage_(ev, conflicts));
    return;
  }

  const created = createCalendarEvent(ev);
  appendLog(baseLog_(ctx, {
    finalJson: JSON.stringify(toIsoEvent(ev)),
    status: STATUS.SUCCESS,
    calendarEventId: created.eventId
  }));
  replyLine(ctx.replyToken, '已加入行事曆：' + ev.title + '\n' + formatRange(ev));
}

function parseWhatIfCommand_(text) {
  const raw = String(text || '');
  const match = raw.match(/^\s*(what\s*-?\s*if|what-if|模擬)\s*[:：]\s*/i);
  if (!match) return { matched: false, text: raw };
  return { matched: true, text: raw.slice(match[0].length).trim() };
}

function normalizeParsedRoute_(ctx, parsed, lastEvent, pending) {
  if (!parsed || (parsed.intent !== INTENTS.CORRECTION && parsed.intent !== INTENTS.UPDATE)) return parsed;
  if (isExplicitCorrectionRequest_(ctx.text, lastEvent, pending)) return parsed;
  if (!looksLikeCompleteNewEventRequest_(ctx.text, parsed)) return parsed;
  return Object.assign({}, parsed, { intent: INTENTS.CREATE });
}

function looksLikeCompleteNewEventRequest_(text, parsed) {
  const raw = String(text || '');
  const event = parsed && parsed.event;
  if (!event || !event.title || !event.start || !event.end) return false;
  const hasActivity = /牙醫|看醫|復健|課|活動|整理|吃飯|回診|看診/.test(raw);
  const hasTime = /週|星期|今天|明天|後天|早上|上午|中午|下午|晚上|\d+\s*點/.test(raw);
  const hasParticipantOrPlace = /爸爸|媽媽|妞妞|孩子A|家長A|家長B|住家區|市區|帶/.test(raw);
  return hasActivity && hasTime && hasParticipantOrPlace;
}

function isExplicitCorrectionRequest_(text, lastEvent, pending) {
  const raw = String(text || '').trim();
  if (pending) return true;
  if (!lastEvent) return false;
  if (/^(不是|不對|更正|修正|剛剛|剛才|上一筆|上一個|那筆|這筆)/.test(raw)) return true;
  if (/把.+從.+改到/.test(raw)) return true;
  if (/^(改成|改到|時間改|日期改)/.test(raw)) return true;
  return false;
}

function handleWhatIfCommand_(ctx, commandText) {
  const lastEvent = findLastCalendarLog(ctx.groupId);
  const pending = getPendingConflict(ctx.groupId);
  const examples = loadFewShotExamples();
  const parsed = parseWithLLM(commandText, lastEvent, examples, pending, ctx.groupId, ctx.userId);
  ctx.intent = 'what_if';
  ctx.geminiJson = JSON.stringify(parsed);

  if (parsed.intent !== INTENTS.CREATE || !parsed.event) {
    appendLog(baseLog_(ctx, {
      status: STATUS.ERROR,
      errorMessage: 'what-if command did not parse to create intent'
    }));
    replyLine(ctx.replyToken, 'What-if 目前需要是一個新行程需求，請用「What-if：日期時間 + 誰 + 做什麼 + 多久」。');
    return;
  }

  const ev = normalizeEventEntities(ctx.groupId, validateEvent(parsed.event));
  const eventDraft = toIsoEvent(ev);
  const baselineStart = startOfDay_(ev.start);
  const baselineEnd = new Date(baselineStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const baseline = buildSevenDayBaseline_({
    groupId: ctx.groupId,
    start: baselineStart,
    end: baselineEnd
  });
  const demand = buildWhatIfDemand_(eventDraft, ctx.groupId);
  const hardConflicts = CONFIG.CONFLICT_CHECK ? detectCalendarConflicts(ev, {
    groupId: ctx.groupId,
    events: baseline.calendarEvents
  }).filter((c) => c.severity === 'hard') : [];
  const preliminaryOptions = generateWhatIfV1Scenarios_({
    groupId: ctx.groupId,
    eventDraft: eventDraft,
    demand: demand,
    baseline: baseline
  });

  console.log('ROUTE_WHATIF_PREFLIGHT');
  replyWhatIfDecision_(ctx, ev, {
    eventDraft: eventDraft,
    hardConflicts: hardConflicts,
    baseline: baseline,
    demand: demand,
    preliminaryOptions: preliminaryOptions,
    reason: 'explicit what-if command'
  });
}

function replyWhatIfDecision_(ctx, ev, input) {
  if (!CONFIG.WHAT_IF_ENABLED || !CONFIG.DECISION_LOG_ENABLED) {
    replyLine(ctx.replyToken, 'What-if 目前未啟用。');
    return;
  }
  const eventDraft = input.eventDraft || toIsoEvent(ev);
  const hardConflicts = input.hardConflicts || [];
  const baseline = input.baseline;
  const demand = input.demand;
  const research = validateResearchResult(runWebResearch(ctx.text));
  const options = (input.preliminaryOptions || []).length ? input.preliminaryOptions : generateWhatIfScenarios({
    groupId: ctx.groupId,
    eventDraft: eventDraft,
    conflicts: hardConflicts,
    demand: demand,
    baseline: baseline,
    profileContext: buildFamilyProfileSnapshot(ctx.groupId),
    research: research
  });
  const possible = removeImpossibleScenarios(options, hardConflicts);
  const ranked = limitRankedForLine_(rankScenarios(possible, {
    conflicts: hardConflicts,
    research: research,
    baseline: baseline,
    demand: demand,
    profile: baseline.profile
  }));
  const decisionId = createDecisionRecord({
    group_id: ctx.groupId,
    source_log_id: ctx.logId,
    requester_user_id: ctx.userId,
    event_draft_json: safeJsonStringify_(eventDraft),
    conflicts_json: safeJsonStringify_({ hardConflicts: hardConflicts, baselineRejections: optionRejections_(options) }),
    options_json: safeJsonStringify_(ranked.ranked),
    recommended_option_id: ranked.best ? ranked.best.optionId : '',
    research_json: safeJsonStringify_(research),
    status: 'pending'
  });
  if (!decisionId) throw new Error('decision_log 寫入失敗');
  console.log('ROUTE_WHATIF_OPTIONS');
  appendLog(baseLog_(ctx, {
    finalJson: safeJsonStringify_(eventDraft),
    status: STATUS.PENDING,
    errorMessage: input.reason || 'what-if decision required',
    relatedLogId: decisionId
  }));
  replyDecisionOptions(ctx.replyToken, buildDecisionReply_(decisionId, ranked), decisionId, ranked);
}

/** 查詢行程：LLM 解析出時間範圍 → 讀 Calendar → 條列回覆 */
function handleQuery_(ctx, parsed) {
  const range = validateRange(parsed.range);
  const events = listEvents(range.start, range.end);

  appendLog(baseLog_(ctx, {
    finalJson: JSON.stringify({
      start: formatIso_(range.start),
      end: formatIso_(range.end),
      count: events.length
    }),
    status: STATUS.SUCCESS
  }));

  const label = formatDayRange_(range.start, range.end);
  if (events.length === 0) {
    replyLine(ctx.replyToken, label + ' 沒有任何行程。');
    return;
  }

  const shown = events.slice(0, CONFIG.QUERY_MAX_EVENTS)
    .map((e) => '・' + e.title + '　' + formatIsoRange_(e.start, e.end));
  const more = events.length > CONFIG.QUERY_MAX_EVENTS
    ? '\n…還有 ' + (events.length - CONFIG.QUERY_MAX_EVENTS) + ' 筆' : '';
  replyLine(ctx.replyToken, label + ' 的行程：\n' + shown.join('\n') + more);
}

/** 處理使用者對衝突的決定（AI loop 的回收端） */
function handleResolve_(ctx, parsed, lastEvent, pending) {
  if (!pending) {
    // 等待狀態已逾時消失，卻判成 resolve → 告知後當一般訊息處理
    appendLog(baseLog_(ctx, { status: STATUS.IGNORED, errorMessage: 'resolve without pending' }));
    replyLine(ctx.replyToken, '剛才的衝突詢問已逾時（' + CONFIG.PENDING_TTL_MINUTES +
      ' 分鐘），請重新發一次完整的行程訊息。');
    return;
  }

  const r = parsed.resolution || {};
  const newEv = validateEvent(pending.newEvent);  // 原本要建立的新行程

  switch (r.action) {
    case 'cancel': {
      clearPendingConflict(ctx.groupId);
      markLogStatus(pending.logId, STATUS.CANCELLED);
      appendLog(baseLog_(ctx, { status: STATUS.SUCCESS, relatedLogId: pending.logId }));
      replyLine(ctx.replyToken, '好的，已取消建立「' + newEv.title + '」。');
      return;
    }

    case 'keep_both': {
      const created = createCalendarEvent(newEv);
      finishResolve_(ctx, pending, newEv, created.eventId, '兩個行程都保留。已加入行事曆：');
      return;
    }

    case 'reschedule_new': {
      if (!r.event) { askForTime_(ctx, pending, '新行程「' + newEv.title + '」'); return; }
      const ev = validateEvent(r.event);
      const created = createCalendarEvent(ev);
      finishResolve_(ctx, pending, ev, created.eventId, '已改時間並加入行事曆：');
      return;
    }

    case 'move_existing': {
      if (!r.event) {
        askForTime_(ctx, pending, '現有行程');
        return;
      }
      const idx = Math.max(1, r.targetIndex || 1) - 1;
      const target = pending.conflicts[idx] || pending.conflicts[0];
      const moved = validateEvent(r.event);

      updateCalendarEvent(target.eventId, moved);
      const created = createCalendarEvent(newEv);

      clearPendingConflict(ctx.groupId);
      markLogStatus(pending.logId, STATUS.RESOLVED);
      appendLog(baseLog_(ctx, {
        finalJson: JSON.stringify({ moved: toIsoEvent(moved), created: toIsoEvent(newEv) }),
        status: STATUS.SUCCESS,
        calendarEventId: created.eventId,
        relatedLogId: pending.logId
      }));
      replyLine(ctx.replyToken,
        '已把「' + target.title + '」改到 ' + formatRange(moved) +
        '\n並加入新行程：' + newEv.title + '\n' + formatRange(newEv));
      return;
    }

    default: {
      const record = baseLog_(ctx, {
        status: STATUS.ERROR,
        errorMessage: 'unknown resolution action: ' + r.action,
        relatedLogId: pending.logId
      });
      appendLog(record);
      tryCreateReflection_(record, 'error');
      replyLine(ctx.replyToken,
        '我不太確定你的意思。請回覆：\n1. 把現有行程改時間（請說改到何時）\n' +
        '2. 把新行程改時間（請說改到何時）\n3. 兩個都保留\n或回覆「取消」。');
    }
  }
}

/** 修正最近一筆行程（學習閉環的入口） */
function handleCorrection_(ctx, parsed, lastEvent) {
  console.log('ROUTE_UPDATE');
  if (!lastEvent) {
    const record = baseLog_(ctx, { status: STATUS.ERROR, errorMessage: 'no recent event to correct' });
    appendLog(record);
    tryCreateReflection_(record, 'error');
    replyLine(ctx.replyToken, '找不到 ' + CONFIG.CORRECTION_WINDOW_HOURS + ' 小時內可修正的行程。');
    return;
  }

  const ev = validateEvent(parsed.event);
  const updated = updateCalendarEvent(lastEvent.calendarEventId, ev);
  if (!updated || !updated.eventId) throw new Error('Calendar update did not return a valid event result');

  appendLog(baseLog_(ctx, {
    finalJson: JSON.stringify(toIsoEvent(ev)),
    status: STATUS.SUCCESS,
    calendarEventId: lastEvent.calendarEventId,
    relatedLogId: lastEvent.logId
  }));
  markLogStatus(lastEvent.logId, STATUS.CORRECTED);
  appendExampleCandidate(
    lastEvent.rawText + '（後續修正：' + ctx.text + '）',
    JSON.stringify(toIsoEvent(ev))
  );
  tryCreateReflection_(Object.assign({}, lastEvent, {
    status: STATUS.CORRECTED,
    correctionText: ctx.text,
    correctedJson: JSON.stringify(toIsoEvent(ev))
  }), 'corrected');
  tryExtractProfileMemory_({
    groupId: ctx.groupId,
    userId: ctx.userId,
    sourceLogId: lastEvent.logId,
    rawText: lastEvent.rawText,
    originalParsedResult: safeJsonParse_(lastEvent.geminiJson, {}),
    correctionText: ctx.text,
    finalCorrectResult: toIsoEvent(ev)
  });

  replyLine(ctx.replyToken, '已修正行程：' + ev.title + '\n' + formatRange(ev));
}

/** 閒聊：靜默記錄，不打擾群組 */
function handleNone_(ctx) {
  appendLog(baseLog_(ctx, { status: STATUS.IGNORED }));
  if (CONFIG.REPLY_ON_NONE) {
    replyLine(ctx.replyToken, '（這句看起來不是行程，我先略過）');
  }
}

/** 已能辨識意圖、但功能尚未實作的骨架 */
function handleNotImplemented_(ctx) {
  if (ctx && (ctx.intent === INTENTS.UPDATE || ctx.intent === INTENTS.DELETE)) console.log('ROUTE_UPDATE');
  appendLog(baseLog_(ctx, { status: STATUS.SKIPPED }));
  replyLine(ctx.replyToken,
    '這個功能還在開發中。目前支援：新增行程（含衝突詢問）、查詢行程、修正最近一筆行程。');
}

// ---------------------------------------------------------------- 衝突迴圈工具

function buildConflictMessage_(ev, conflicts) {
  const lines = conflicts.map((c, i) =>
    (i + 1) + '. ' + c.title + '　' + formatIsoRange_(c.start, c.end));
  return '「' + ev.title + '」（' + formatRange(ev) + '）和現有行程衝突：\n' +
    lines.join('\n') +
    '\n\n要怎麼處理？直接用一般說話回覆即可：\n' +
    '1. 把現有行程改時間（請說改到何時）\n' +
    '2. 把新行程改時間（請說改到何時）\n' +
    '3. 兩個都保留\n' +
    '或回覆「取消」放棄建立。（' + CONFIG.PENDING_TTL_MINUTES + ' 分鐘內有效）';
}

/** 使用者選了方向但沒給具體時間 → 追問並延長等待狀態 */
function askForTime_(ctx, pending, what) {
  savePendingConflict(ctx.groupId, pending);  // 重新寫入以重置 TTL
  appendLog(baseLog_(ctx, { status: STATUS.PENDING, relatedLogId: pending.logId }));
  replyLine(ctx.replyToken, '好的，要把' + what + '改到什麼時候？（例如「改到明天下午4點」）');
}

function finishResolve_(ctx, pending, ev, eventId, prefix) {
  clearPendingConflict(ctx.groupId);
  markLogStatus(pending.logId, STATUS.RESOLVED);
  appendLog(baseLog_(ctx, {
    finalJson: JSON.stringify(toIsoEvent(ev)),
    status: STATUS.SUCCESS,
    calendarEventId: eventId,
    relatedLogId: pending.logId
  }));
  replyLine(ctx.replyToken, prefix + ev.title + '\n' + formatRange(ev));
}

// ---------------------------------------------------------------- 工具

function isTextMessageEvent_(event) {
  return !!(event &&
    event.type === 'message' &&
    event.replyToken &&
    event.message &&
    event.message.type === 'text');
}

function buildContext_(event) {
  const ctx = buildContextFromSource_(event.source || {});
  ctx.replyToken = event.replyToken;
  ctx.text = event.message.text;
  return ctx;
}

function buildContextFromSource_(source) {
  return {
    logId: Utilities.getUuid(),
    groupId: source.groupId || source.userId || '',  // 1對1 聊天時以 userId 當 groupId
    userId: source.userId || '',
    text: ''
  };
}

function isPostbackEvent_(event) {
  return !!(event && event.type === 'postback' && event.replyToken && event.postback);
}

function handlePostbackEvent_(ctx, event) {
  ctx.replyToken = event.replyToken;
  const data = parsePostbackData_(event.postback.data || '');
  if (data.action !== 'select_decision_option') {
    replyLine(ctx.replyToken, '這個操作目前無法處理。');
    return;
  }

  const decision = getDecisionById(data.decisionId);
  if (!decision || decision.group_id !== ctx.groupId || decision.requester_user_id !== ctx.userId) {
    replyLine(ctx.replyToken, '找不到可執行的方案，請重新發一次行程。');
    return;
  }

  const validation = revalidateDecisionOption(decision, data.optionId);
  if (!validation.valid) {
    replyLine(ctx.replyToken, '這個舊方案已失效，請重新發一次行程，我會重新檢查目前行事曆。');
    return;
  }

  const action = validation.option.action || {};
  const firstSelection = decision.status !== 'selected' && decision.status !== 'executed';
  recordSelectedOption(data.decisionId, data.optionId);
  if (firstSelection) tryLearnFromSelection_(decision, data.optionId);
  if (action.kind === 'create') {
    const ev = validateEvent(action.event);
    const created = createCalendarEvent(ev);
    recordDecisionExecution(data.decisionId, { action: action, calendarEventId: created.eventId });
    markLogStatus(decision.source_log_id, STATUS.RESOLVED);
    replyLine(ctx.replyToken, '已加入行事曆：' + ev.title + '\n' + formatRange(ev));
    return;
  }
  if (action.kind === 'apply_plan') {
    const result = executeScenarioAction_(action);
    recordDecisionExecution(data.decisionId, result);
    markLogStatus(decision.source_log_id, STATUS.RESOLVED);
    replyLine(ctx.replyToken, buildScenarioExecutionReply_(result));
    return;
  }

  replyLine(ctx.replyToken, '請補充你想怎麼調整，我再幫你建立。');
}

function parsePostbackData_(raw) {
  return String(raw || '').split('&').reduce((acc, pair) => {
    const parts = pair.split('=');
    acc[decodeURIComponent(parts[0] || '')] = decodeURIComponent(parts[1] || '');
    return acc;
  }, {});
}

/** 組 log 紀錄的共同欄位，handler 只需補上差異欄位 */
function baseLog_(ctx, extra) {
  return Object.assign({
    logId: ctx.logId,
    groupId: ctx.groupId,
    userId: ctx.userId,
    rawText: ctx.text,
    intent: ctx.intent,
    geminiJson: ctx.geminiJson
  }, extra);
}

/** 最外層錯誤處理：盡力記錄、盡力回覆，但不再丟出例外 */
function handleFatalError_(ctx, err) {
  const message = redactSecrets_(String((err && err.message) || err));
  let record = null;
  try {
    record = baseLog_(ctx || {}, { status: STATUS.ERROR, errorMessage: message });
    appendLog(record);
  } catch (_) { /* 連記錄都失敗時放棄，避免無限循環 */ }
  if (record) tryCreateReflection_(record, reflectionTriggerType_(record));
  if (ctx && ctx.replyToken) safeReply(ctx.replyToken, '處理失敗：' + message);
}

function tryCreateReflection_(record, triggerType) {
  try {
    maybeCreateReflectionMemory_(record, triggerType);
  } catch (err) {
    console.log('Reflection failed: ' + redactSecrets_(String((err && err.message) || err)));
  }
}

function tryExtractProfileMemory_(input) {
  try {
    extractProfileMemoryCandidates(input);
  } catch (err) {
    console.log('Profile memory failed: ' + redactSecrets_(String((err && err.message) || err)));
  }
}

/** 偏好回寫的非致命包裝：學習失敗絕不影響使用者已完成的決策執行 */
function tryLearnFromSelection_(decision, selectedOptionId) {
  try {
    learnFromDecisionSelection_(decision, selectedOptionId);
  } catch (err) {
    console.log('Decision learning failed: ' + redactSecrets_(String((err && err.message) || err)));
  }
}

function tryHandleDecisionFeedback_(ctx) {
  if (!/照方案|有照|沒照|沒有照|實際|回饋|結果|下次|以後/.test(ctx.text || '')) return false;
  const decision = findLatestDecisionForFeedback(ctx.groupId, ctx.userId);
  if (!decision) return false;

  const outcome = /沒照|沒有照|失敗|不順/.test(ctx.text) ? 'not_followed' : 'followed';
  recordDecisionOutcome(decision.decision_id, outcome, ctx.text);
  if (/下次|以後|偏好|優先|避免/.test(ctx.text)) {
    appendProfileMemory({
      group_id: ctx.groupId || '*',
      subject_id: '',
      memory_type: 'preference',
      canonical_value: ctx.text,
      variants_json: safeJsonStringify_([]),
      rule_json: safeJsonStringify_({ source: 'what_if_feedback' }),
      evidence_log_ids: safeJsonStringify_([decision.source_log_id].filter(Boolean)),
      source_type: 'explicit_statement',
      confidence: 0.9,
      status: 'active'
    });
    updateDecisionRecord_(decision.decision_id, { reflection_created: 'profile_memory' });
  }
  appendLog(baseLog_(ctx, {
    intent: 'feedback',
    geminiJson: '',
    finalJson: safeJsonStringify_({ decisionId: decision.decision_id, outcome: outcome }),
    status: STATUS.SUCCESS,
    relatedLogId: decision.decision_id
  }));
  replyLine(ctx.replyToken, '已記錄這次 What-if 結果，之後相似情境會納入排序參考。');
  return true;
}

function optionRejections_(options) {
  return (options || [])
    .filter((o) => o.hardConflict)
    .map((o) => ({ optionId: o.optionId, title: o.title, reason: o.rejectionReason || 'hard conflict' }));
}

function executeScenarioAction_(action) {
  const plan = action.plan || {};
  const event = validateEvent(action.event);
  const moved = [];
  (plan.moves || action.moves || []).forEach((move) => {
    const from = move.from || {};
    const to = move.to || {};
    if (from.source === 'calendar' && from.eventId) {
      const updated = updateCalendarTestEventOnly(from.eventId, {
        title: from.title,
        start: to.start,
        end: to.end
      });
      moved.push(updated);
    }
  });
  const created = createCalendarEvent(event);
  return {
    action: action,
    calendarEventId: created.eventId,
    moved: moved,
    optionId: plan.optionId || ''
  };
}

function buildScenarioExecutionReply_(result) {
  const action = result.action || {};
  const event = validateEvent(action.event);
  const lines = ['已依方案加入行事曆：' + event.title, formatRange(event)];
  if ((result.moved || []).length) {
    lines.push('並移動測試事件：' + result.moved.map((m) => m.title).join('、'));
  }
  lines.push('完成後可回覆「有照方案」或「沒照方案，實際是...」，我會記錄回饋。');
  return lines.join('\n');
}
