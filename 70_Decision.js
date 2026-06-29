/**
 * 70_Decision.gs — what-if scenarios, deterministic scoring, and decision learning.
 */

function generateWhatIfScenarios(input) {
  if (input && input.baseline) return generateWhatIfV1Scenarios_(input);
  if (CONFIG.WHAT_IF_ENABLED) {
    const llmOptions = generateWhatIfScenariosWithLlm_(input);
    if (llmOptions.length) return llmOptions;
  }
  return generateFallbackWhatIfScenarios_(input);
}

function generateWhatIfScenariosWithLlm_(input) {
  try {
    const parsed = parseJsonLoose_(callWhatIfPlannerLlm_(buildWhatIfPlannerPrompt_(input)));
    const options = Array.isArray(parsed.options) ? parsed.options : [];
    const normalized = options.map(normalizeScenarioOption_).filter(validateScenarioSchema);
    return ensureScenarioTypes_(normalized, input);
  } catch (err) {
    console.log('What-if LLM failed: ' + shortError_(err));
    return [];
  }
}

function buildWhatIfPlannerPrompt_(input) {
  return [
    '你是家庭行事曆的 what-if 智慧規劃器。',
    '根據新事件、確定性衝突、家庭 profile、外部證據狀態，提出可執行候選方案。',
    '必須輸出嚴格 JSON：{"options":[...]}，不要 markdown。',
    '必須包含三類候選：AS_PROPOSED, TIME_SHIFT, METHOD_CHANGE。',
    'LLM 只提出候選與理由；最後排序由程式處理。',
    '不要假設未提供的家庭成員姓名。需要確認就 requiresConfirmation=true。',
    '',
    'eventDraft:',
    safeJsonStringify_(input.eventDraft || {}),
    '',
    'conflicts:',
    safeJsonStringify_(input.conflicts || []),
    '',
    'profileContext:',
    safeJsonStringify_(input.profileContext || {}),
    '',
    'research:',
    safeJsonStringify_(input.research || { evidenceStatus: 'not_searched' })
  ].join('\n');
}

function callWhatIfPlannerLlm_(prompt) {
  const model = CONFIG.WHAT_IF_MODEL || 'gpt-5.4-mini';
  if (/gpt-5\.5/i.test(model)) {
    throw new Error('WHAT_IF_MODEL requires approval before using gpt-5.5');
  }
  if (!CONFIG.OPENAI_API_KEY) throw new Error('未設定 OPENAI_API_KEY，改用 deterministic fallback');
  return callOpenAIModel_(model, prompt);
}

function callOpenAIModel_(model, prompt) {
  const res = fetchWithRetry_('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.OPENAI_API_KEY },
    payload: JSON.stringify({
      model: model,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('OpenAI what-if failed: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
  const data = JSON.parse(res.getContentText());
  const raw = data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('OpenAI what-if 回應為空');
  return raw;
}

function generateFallbackWhatIfScenarios_(input) {
  const draft = input.eventDraft || {};
  const start = new Date(draft.start);
  const end = new Date(draft.end);
  const duration = end.getTime() - start.getTime();
  const shiftedStart = new Date(start.getTime() + 60 * 60 * 1000);
  const shiftedEnd = new Date(shiftedStart.getTime() + duration);

  return [
    {
      optionId: 'A',
      type: 'AS_PROPOSED',
      title: '照原時間建立',
      action: { kind: 'create', event: draft },
      consequences: ['可能與既有行程衝突'],
      assumptions: [],
      hardConflict: (input.conflicts || []).some((c) => c.severity === 'hard'),
      requiresConfirmation: false,
      uncertainty: 'low',
      leave: { hours: 0 },
      moves: [],
      reassignments: [],
      cascadeCount: 0,
      cost: { leaveHours: 0, rearrangeCount: 0, cascadeCount: 0, total: 0 }
    },
    {
      optionId: 'B',
      type: 'TIME_SHIFT',
      title: '改到晚一小時',
      action: {
        kind: 'create',
        event: Object.assign({}, draft, { start: formatIso_(shiftedStart), end: formatIso_(shiftedEnd) })
      },
      consequences: [],
      assumptions: ['可接受晚一小時'],
      hardConflict: false,
      requiresConfirmation: true,
      uncertainty: 'medium',
      leave: { hours: 0 },
      moves: [],
      reassignments: [],
      cascadeCount: 0,
      cost: { leaveHours: 0, rearrangeCount: 0, cascadeCount: 0, total: 0 }
    },
    {
      optionId: 'C',
      type: 'METHOD_CHANGE',
      title: '保留原時間，但更換執行方式或執行者',
      action: { kind: 'ask_confirmation', event: draft },
      consequences: [],
      assumptions: ['家庭成員可協調執行方式'],
      hardConflict: false,
      requiresConfirmation: true,
      uncertainty: 'medium',
      leave: { hours: 0 },
      moves: [],
      reassignments: [{ from: '', to: '' }],
      cascadeCount: 0,
      cost: { leaveHours: 0, rearrangeCount: 1, cascadeCount: 0, total: 1 }
    }
  ].filter(validateScenarioSchema);
}

function buildSevenDayBaseline_(input) {
  const start = input.start || new Date();
  const end = input.end || new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const groupId = input.groupId || '';
  const members = input.familyProfile || findFamilyProfilesByGroup(groupId);
  const routines = input.routineModel || findRoutineModelsByGroup(groupId);
  const normalizedMembers = members.map(normalizeFamilyMember_);
  const calendarEvents = (input.calendarEvents || listEvents(start, end))
    .map((e) => normalizeBaselineCalendarEvent_(e, groupId, normalizedMembers));
  const routineEvents = expandRoutineEvents_(routines, start, end);
  return {
    groupId: groupId,
    start: formatIso_(start),
    end: formatIso_(end),
    members: normalizedMembers,
    profile: input.profile || (input.familyProfile ? buildProfileSnapshotFromMembers_(normalizedMembers) :
      buildFamilyProfileSnapshot(groupId)),
    calendarEvents: calendarEvents,
    routineEvents: routineEvents,
    events: calendarEvents.concat(routineEvents)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
  };
}

function buildProfileSnapshotFromMembers_(members) {
  const snapshot = { people: [], aliases: [], constraints: [], preferences: [] };
  (members || []).forEach((m) => {
    snapshot.people.push({ subjectId: m.member_id, name: m.name });
    snapshot.aliases.push({
      subjectId: m.member_id,
      canonicalValue: m.name,
      variants: m.aliases || [],
      rule: { role: m.role, requiresAdultCompanion: m.requires_adult_companion }
    });
    if (m.requires_adult_companion) {
      snapshot.constraints.push({
        subjectId: m.member_id,
        canonicalValue: m.name + '外出、接送、就醫或照護需要成人陪同',
        rule: { requiresAdultCompanion: true }
      });
    }
  });
  return snapshot;
}

function normalizeFamilyMember_(member) {
  return {
    member_id: member.member_id || member.subjectId || '',
    name: member.name || member.canonicalValue || '',
    aliases: safeJsonParse_(member.aliases_json, member.variants || []),
    role: member.role || '',
    work_location: member.work_location || '',
    weekday_start: member.weekday_start || '',
    weekday_end: member.weekday_end || '',
    requires_adult_companion: member.requires_adult_companion === true ||
      String(member.requires_adult_companion).toUpperCase() === 'TRUE'
  };
}

function normalizeBaselineCalendarEvent_(event, groupId, members) {
  const resolved = (members && members.length) ? event : normalizeEventEntities(groupId, event);
  const personId = resolved.personEntity && resolved.personEntity.canonicalPersonId;
  const title = String(event.title || '');
  const isTest = title.indexOf('[WHATIF_TEST]') === 0;
  const participantIds = personId ? [personId] : extractParticipantIdsFromMembers_(members || [], title);
  return {
    source: 'calendar',
    eventId: event.eventId || '',
    title: title,
    start: event.start,
    end: event.end,
    participantIds: participantIds,
    ownerId: personId || '',
    location: event.location || inferLocationFromText_(title),
    movable: event.movable === true || isTest,
    isTestEvent: isTest,
    eventType: isTest ? 'test' : 'calendar'
  };
}

function expandRoutineEvents_(routines, start, end) {
  const events = [];
  for (let d = startOfDay_(start); d < end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    const weekday = Number(Utilities.formatDate(d, CONFIG.TIMEZONE, 'u'));
    routines.forEach((routine) => {
      if (parseWeekdays_(routine.weekday).indexOf(weekday) === -1) return;
      const begin = dateAtTime_(d, routine.start_time || '00:00');
      const finish = dateAtTime_(d, routine.end_time || '00:00');
      events.push({
        source: 'routine',
        routineId: routine.routine_id || '',
        title: routine.title || '',
        start: formatIso_(begin),
        end: formatIso_(finish),
        participantIds: safeJsonParse_(routine.participant_ids_json, []),
        ownerId: routine.owner_id || '',
        location: routine.location || '',
        movable: routine.movable === true || String(routine.movable).toUpperCase() === 'TRUE',
        eventType: routine.event_type || 'routine',
        needsAdult: routine.needs_adult === true || String(routine.needs_adult).toUpperCase() === 'TRUE'
      });
    });
  }
  return events;
}

function parseWeekdays_(raw) {
  return String(raw || '').split(',').map((s) => Number(String(s).trim())).filter(Boolean);
}

function startOfDay_(date) {
  const label = Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return new Date(label + 'T00:00:00+08:00');
}

function dateAtTime_(date, hhmm) {
  const label = Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return new Date(label + 'T' + hhmm + ':00+08:00');
}

function buildWhatIfDemand_(eventDraft, groupId) {
  const start = new Date(eventDraft.start);
  const end = new Date(eventDraft.end);
  const participantIds = extractParticipantIdsFromText_(groupId, eventDraft.title);
  const rangeStart = startOfDay_(start);
  const rangeEnd = new Date(rangeStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);
  return {
    title: eventDraft.title,
    requiredParticipantIds: participantIds,
    location: eventDraft.location || inferLocationFromText_(eventDraft.title),
    durationMinutes: Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000)),
    dateRangeStart: formatIso_(rangeStart),
    dateRangeEnd: formatIso_(rangeEnd)
  };
}

function extractParticipantIdsFromText_(groupId, text) {
  const ids = [];
  findFamilyProfilesByGroup(groupId).forEach((m) => {
    const aliases = [m.name].concat(safeJsonParse_(m.aliases_json, []));
    if (aliases.some((a) => a && String(text || '').indexOf(a) !== -1)) ids.push(m.member_id);
  });
  return uniqueStrings_(ids);
}

function extractParticipantIdsFromMembers_(members, text) {
  const ids = [];
  (members || []).forEach((m) => {
    const aliases = [m.name].concat(m.aliases || []);
    if (aliases.some((a) => a && String(text || '').indexOf(a) !== -1)) ids.push(m.member_id);
  });
  return uniqueStrings_(ids);
}

function inferLocationFromText_(text) {
  const raw = String(text || '');
  if (raw.indexOf('市區') !== -1) return '市區';
  if (raw.indexOf('住家區') !== -1) return '住家區';
  if (/醫|診所|復健|接送|外出|課/.test(raw)) return '住家區';
  return '';
}

function planWhatIfCalendarV1(input) {
  const options = generateWhatIfV1Scenarios_(input);
  const possible = removeImpossibleScenarios(options, [], input);
  return rankScenarios(possible, {
    baseline: input.baseline,
    demand: input.demand,
    profile: input.baseline && input.baseline.profile
  });
}

function generateWhatIfV1Scenarios_(input) {
  const baseline = input.baseline || { events: [], members: [], profile: { preferences: [] } };
  const eventDraft = Object.assign({}, input.eventDraft || {});
  const demand = input.demand || buildWhatIfDemand_(eventDraft, input.groupId || baseline.groupId || '');
  const options = [];
  options.push(buildAsProposedOption_(eventDraft, demand, baseline));
  buildDateOrTimeOptions_(eventDraft, demand, baseline).forEach((o) => options.push(o));
  buildMoveEventOptions_(eventDraft, demand, baseline).forEach((o) => options.push(o));
  buildReassignmentOptions_(eventDraft, demand, baseline).forEach((o) => options.push(o));
  buildLeaveOptions_(eventDraft, demand, baseline).forEach((o) => options.push(o));
  return dedupeScenarioOptions_(options)
    .map((o, i) => finalizeScenarioOption_(o, i, baseline, demand))
    .filter(validateScenarioSchema)
    .filter((o) => !o.hardConflict || o.type === 'AS_PROPOSED')
    .filter(limitScenarioTypeCount_());
}

function limitScenarioTypeCount_() {
  const counts = {};
  const limits = {
    AS_PROPOSED: 1,
    TIME_SHIFT: 2,
    DATE_CHANGE: 3,
    MOVE_EVENT: 2,
    REASSIGN_OWNER: 2,
    LEAVE: 2,
    METHOD_CHANGE: 1
  };
  return function (option) {
    counts[option.type] = (counts[option.type] || 0) + 1;
    return counts[option.type] <= (limits[option.type] || 1);
  };
}

function buildAsProposedOption_(eventDraft, demand, baseline) {
  return {
    optionId: 'A',
    type: 'AS_PROPOSED',
    title: '照原需求安排',
    action: { kind: 'apply_plan', event: eventDraft, moves: [] },
    newEvent: buildPlannedNewEvent_(eventDraft, demand, pickAdultOwner_(baseline, eventDraft.start)),
    moves: [],
    reassignments: [],
    leave: { hours: 0 },
    cascadeCount: 0,
    assumptions: [],
    consequences: ['不改變既有行程'],
    uncertainty: 'low'
  };
}

function buildDateOrTimeOptions_(eventDraft, demand, baseline) {
  const durationMs = demand.durationMinutes * 60 * 1000;
  const originalStart = new Date(eventDraft.start);
  const slots = candidateStartTimes_(originalStart, demand);
  const options = [];
  slots.forEach((start, index) => {
    const shifted = Object.assign({}, eventDraft, {
      start: formatIso_(start),
      end: formatIso_(new Date(start.getTime() + durationMs))
    });
    const owner = pickAdultOwner_(baseline, shifted.start);
    options.push({
      optionId: '',
      type: sameCalendarDay_(originalStart, start) ? 'TIME_SHIFT' : 'DATE_CHANGE',
      title: sameCalendarDay_(originalStart, start) ? '改時間到 ' + formatShortRange_(shifted) :
        '改日期到 ' + formatShortRange_(shifted),
      action: { kind: 'apply_plan', event: shifted, moves: [] },
      newEvent: buildPlannedNewEvent_(shifted, demand, owner),
      moves: [],
      reassignments: [],
      leave: { hours: 0 },
      cascadeCount: 0,
      assumptions: [],
      consequences: ['新需求改到 ' + formatShortRange_(shifted)],
      uncertainty: index < 3 ? 'low' : 'medium'
    });
  });
  return options;
}

function buildMoveEventOptions_(eventDraft, demand, baseline) {
  const direct = buildPlannedNewEvent_(eventDraft, demand, pickAdultOwner_(baseline, eventDraft.start));
  const overlaps = (baseline.events || []).filter((e) => detectTimeOverlap(direct, e));
  const options = [];
  overlaps.filter((e) => e.movable).forEach((event) => {
    const movedStart = findFirstFreeSlot_(event, baseline, [event]);
    if (!movedStart) return;
    const moved = Object.assign({}, event, {
      start: formatIso_(movedStart),
      end: formatIso_(new Date(movedStart.getTime() + eventDurationMs_(event)))
    });
    options.push({
      optionId: '',
      type: 'MOVE_EVENT',
      title: '移動可移動事件，保留新需求原時間',
      action: { kind: 'apply_plan', event: eventDraft, moves: [{ from: event, to: moved }] },
      newEvent: direct,
      moves: [{ from: event, to: moved }],
      reassignments: [],
      leave: leaveForOwnerIfWorking_(direct.ownerId, direct, baseline),
      cascadeCount: countCascadeImpacts_(moved, baseline, [event]),
      assumptions: ['只移動 movable=true 或 [WHATIF_TEST] 事件'],
      consequences: ['移動「' + event.title + '」到 ' + formatIsoRange_(moved.start, moved.end)],
      uncertainty: 'medium'
    });
  });
  return options;
}

function buildReassignmentOptions_(eventDraft, demand, baseline) {
  const options = [];
  adultMembers_(baseline).forEach((adult) => {
    const direct = buildPlannedNewEvent_(eventDraft, demand, adult.member_id);
    options.push({
      optionId: '',
      type: 'REASSIGN_OWNER',
      title: '改由' + adult.name + '承擔',
      action: { kind: 'apply_plan', event: eventDraft, moves: [] },
      newEvent: direct,
      moves: [],
      reassignments: [{ from: '', to: adult.member_id, label: adult.name }],
      leave: leaveForOwnerIfWorking_(adult.member_id, direct, baseline),
      cascadeCount: 0,
      assumptions: ['承擔者可接受此安排'],
      consequences: ['承擔者改為' + adult.name],
      uncertainty: 'medium'
    });
  });
  return options;
}

function buildLeaveOptions_(eventDraft, demand, baseline) {
  return adultMembers_(baseline).map((adult) => {
    const direct = buildPlannedNewEvent_(eventDraft, demand, adult.member_id);
    const leave = leaveForOwnerIfWorking_(adult.member_id, direct, baseline);
    if (!leave.hours) leave.hours = Math.ceil(demand.durationMinutes / 60);
    leave.personId = adult.member_id;
    leave.personName = adult.name;
    return {
      optionId: '',
      type: 'LEAVE',
      title: adult.name + '請假處理',
      action: { kind: 'apply_plan', event: eventDraft, moves: [] },
      newEvent: direct,
      moves: [],
      reassignments: [{ from: '', to: adult.member_id, label: adult.name }],
      leave: leave,
      cascadeCount: 0,
      assumptions: ['工作時段以請假處理，不直接移動工作 routine'],
      consequences: [adult.name + '請假 ' + leave.hours + ' 小時'],
      uncertainty: 'medium'
    };
  });
}

function candidateStartTimes_(originalStart, demand) {
  const starts = [];
  const durationMs = demand.durationMinutes * 60000;
  const rangeStart = new Date(demand.dateRangeStart);
  const rangeEnd = new Date(demand.dateRangeEnd);
  [1, 2, 3].forEach((h) => starts.push(new Date(originalStart.getTime() + h * 60 * 60000)));
  for (let d = startOfDay_(new Date(originalStart.getTime() + 24 * 60 * 60000));
    d <= rangeEnd; d = new Date(d.getTime() + 24 * 60 * 60000)) {
    starts.push(dateAtTime_(d, Utilities.formatDate(originalStart, CONFIG.TIMEZONE, 'HH:mm')));
    starts.push(dateAtTime_(d, '19:00'));
    starts.push(dateAtTime_(d, '09:00'));
  }
  return starts.filter((d) => d >= rangeStart && (d.getTime() + durationMs) <= rangeEnd.getTime());
}

function findFirstFreeSlot_(event, baseline, ignoredEvents) {
  const start = new Date(event.start);
  const demand = {
    durationMinutes: Math.round(eventDurationMs_(event) / 60000),
    dateRangeStart: formatIso_(startOfDay_(start)),
    dateRangeEnd: formatIso_(new Date(startOfDay_(start).getTime() + 7 * 24 * 60 * 60000 - 1000))
  };
  const slots = candidateStartTimes_(new Date(event.end), demand);
  for (let i = 0; i < slots.length; i++) {
    const candidate = Object.assign({}, event, {
      start: formatIso_(slots[i]),
      end: formatIso_(new Date(slots[i].getTime() + eventDurationMs_(event)))
    });
    const overlaps = baseline.events.filter((e) => ignoredEvents.indexOf(e) === -1 && detectTimeOverlap(candidate, e));
    if (!overlaps.length) return slots[i];
  }
  return null;
}

function finalizeScenarioOption_(option, index, baseline, demand) {
  const withId = Object.assign({}, option, { optionId: option.optionId || optionIdForIndex_(index) });
  const rejection = firstHardRejection_(withId, baseline, demand);
  withId.hardConflict = !!rejection;
  withId.rejectionReason = rejection || '';
  withId.cost = calculateScenarioCost_(withId);
  withId.score = withId.cost.total;
  withId.preferenceBoost = preferenceBoostForOption_(withId, baseline.profile || {});
  withId.adjustedScore = withId.cost.total - withId.preferenceBoost;
  withId.requiresConfirmation = true;
  withId.action = Object.assign({}, withId.action || {}, {
    plan: {
      optionId: withId.optionId,
      newEvent: withId.newEvent,
      moves: withId.moves || [],
      reassignments: withId.reassignments || [],
      leave: withId.leave || { hours: 0 },
      cost: withId.cost
    }
  });
  return withId;
}

function firstHardRejection_(option, baseline, demand) {
  if ((option.moves || []).some((m) => m.from && m.from.movable !== true)) {
    return '不可移動事件被直接移動';
  }
  const required = demand.requiredParticipantIds || [];
  if (required.some((id) => option.newEvent.participantIds.indexOf(id) === -1)) {
    return '必須參與的人沒有被安排';
  }
  if (needsAdultCompanion_(option.newEvent, baseline) && !hasAdultParticipant_(option.newEvent, baseline)) {
    return '小孩外出、就醫、接送或照顧時沒有成人陪同';
  }
  return firstFinalScheduleHardRejection_(option, baseline, demand);
}

function firstFinalScheduleHardRejection_(option, baseline, demand) {
  const simulation = buildFinalSimulatedSchedule_(option, baseline);
  for (let i = 0; i < simulation.affectedEvents.length; i++) {
    for (let j = 0; j < simulation.fixedEvents.length; j++) {
      const reason = hardScheduleOverlapRejection_(
        simulation.affectedEvents[i], simulation.fixedEvents[j], option.leave);
      if (reason) return reason;
    }
  }
  for (let a = 0; a < simulation.affectedEvents.length; a++) {
    for (let b = a + 1; b < simulation.affectedEvents.length; b++) {
      const pairedReason = hardScheduleOverlapRejection_(
        simulation.affectedEvents[a], simulation.affectedEvents[b], option.leave);
      if (pairedReason) return pairedReason;
    }
  }
  return '';
}

function buildFinalSimulatedSchedule_(option, baseline) {
  const movedKeys = (option.moves || []).map((m) => baselineEventKey_(m.from));
  const fixedEvents = (baseline.events || []).filter((e) => movedKeys.indexOf(baselineEventKey_(e)) === -1);
  const affectedEvents = [];
  if (option.newEvent) affectedEvents.push(option.newEvent);
  (option.moves || []).forEach((m) => {
    if (m.to) affectedEvents.push(m.to);
  });
  return {
    fixedEvents: fixedEvents,
    affectedEvents: affectedEvents,
    events: fixedEvents.concat(affectedEvents)
  };
}

function baselineEventKey_(event) {
  if (!event) return '';
  return [
    event.source || '',
    event.eventId || '',
    event.routineId || '',
    event.title || '',
    event.start || '',
    event.end || ''
  ].join('|');
}

function hardScheduleOverlapRejection_(a, b, leave) {
  if (!detectTimeOverlap(a, b)) return '';
  if (overlapResolvedByLeave_(a, b, leave)) return '';
  if (shareParticipant_(a, b)) return overlapRejectionReason_(a, b);
  if (hasUnknownParticipants_(a) || hasUnknownParticipants_(b)) {
    return overlapRejectionReason_(a, b);
  }
  return '';
}

function overlapRejectionReason_(planned, existing) {
  if (sharesPersonAtDifferentLocation_(planned, existing)) return '同一人在同一時間出現在不同地點';
  if (existing.eventType === 'school') return '必須參與者上學時段重疊';
  if (isWorkEvent_(existing)) return '必須參與者工作時段重疊';
  if (existing.eventType === 'care') return '照護 routine 時段重疊';
  if (existing.eventType === 'test' || existing.movable) return '可移動事件尚未被移動';
  if (shareParticipant_(planned, existing)) return '同一人在同一時間出現在兩個活動';
  return '方案產生新的時間重疊且未被解決';
}

function calculateScenarioCost_(option) {
  const leaveHours = Number((option.leave && option.leave.hours) || 0);
  const rearrangeCount = (option.moves || []).length + (option.reassignments || []).length;
  const cascadeCount = Number(option.cascadeCount || 0);
  return {
    leaveHours: leaveHours,
    rearrangeCount: rearrangeCount,
    cascadeCount: cascadeCount,
    total: leaveHours * 3 + rearrangeCount + cascadeCount * 2
  };
}

function preferenceBoostForOption_(option, profile) {
  const prefs = profile.preferences || [];
  const text = prefs.map((p) => p.canonicalValue || '').join('\n');
  let boost = 0;
  if (option.type === 'MOVE_EVENT' && (option.moves || []).some((m) => m.from && m.from.movable)) boost += 2;
  if (!text) return boost;
  if (text.indexOf('優先改日期') !== -1 && option.type === 'DATE_CHANGE') boost += 1;
  if (text.indexOf('避免家長B請假') !== -1 &&
    !(option.leave && option.leave.personName === '家長B' && option.leave.hours > 0)) boost += 1;
  return boost;
}

function buildRecommendationReason_(best, profile) {
  if (!best) return '';
  const parts = ['總分最低'];
  if (best.preferenceBoost > 0) {
    const prefs = (profile.preferences || []).map((p) => p.canonicalValue).filter(Boolean);
    if (prefs.length) parts.push('符合記憶：' + prefs[0]);
  }
  return parts.join('；');
}

function normalizeScenarioOption_(option) {
  return {
    optionId: String(option.optionId || '').trim(),
    type: String(option.type || '').trim(),
    title: String(option.title || '').trim().slice(0, 80),
    action: option.action || {},
    consequences: Array.isArray(option.consequences) ? option.consequences.map(String).slice(0, 5) : [],
    assumptions: Array.isArray(option.assumptions) ? option.assumptions.map(String).slice(0, 5) : [],
    hardConflict: option.hardConflict === true,
    requiresConfirmation: option.requiresConfirmation === true,
    uncertainty: ['low', 'medium', 'high'].indexOf(option.uncertainty) !== -1 ? option.uncertainty : 'medium',
    requiresUnconfirmedPerson: option.requiresUnconfirmedPerson === true,
    violatesActiveConstraint: option.violatesActiveConstraint === true,
    violatesActivePreference: option.violatesActivePreference === true,
    bufferRisk: option.bufferRisk === true,
    dependsOnUnknownTravel: option.dependsOnUnknownTravel === true,
    matchesPastSuccess: option.matchesPastSuccess === true
  };
}

function ensureScenarioTypes_(options, input) {
  const types = options.map((o) => o.type);
  if (types.indexOf('AS_PROPOSED') === -1 || types.indexOf('TIME_SHIFT') === -1 ||
    types.indexOf('METHOD_CHANGE') === -1) {
    return generateFallbackWhatIfScenarios_(input);
  }
  return options;
}

function validateScenarioSchema(option) {
  return !!(option && option.optionId && option.type && option.title && option.action &&
    ['AS_PROPOSED', 'TIME_SHIFT', 'DATE_CHANGE', 'MOVE_EVENT', 'REASSIGN_OWNER', 'LEAVE', 'METHOD_CHANGE']
      .indexOf(option.type) !== -1);
}

function removeImpossibleScenarios(options) {
  return (options || []).filter((o) => !o.hardConflict);
}

function scoreScenario(option, context) {
  if (option.hardConflict) return Infinity;
  if (option.cost && typeof option.cost.total === 'number') return option.cost.total;
  return calculateScenarioCost_(option).total;
}

function rankScenarios(options, context) {
  const profile = (context && (context.profile || (context.baseline && context.baseline.profile))) || {};
  const ranked = (options || [])
    .map((o) => {
      const cost = o.cost || calculateScenarioCost_(o);
      const boost = o.preferenceBoost !== undefined ? o.preferenceBoost : preferenceBoostForOption_(o, profile);
      return Object.assign({}, o, {
        cost: cost,
        score: cost.total,
        preferenceBoost: boost,
        adjustedScore: cost.total - boost
      });
    })
    .filter((o) => o.score < Infinity)
    .sort((a, b) => {
      if (a.adjustedScore !== b.adjustedScore) return a.adjustedScore - b.adjustedScore;
      if (a.cost.leaveHours !== b.cost.leaveHours) return a.cost.leaveHours - b.cost.leaveHours;
      const affectedA = (a.moves || []).length + (a.reassignments || []).length + (a.cost.cascadeCount || 0);
      const affectedB = (b.moves || []).length + (b.reassignments || []).length + (b.cost.cascadeCount || 0);
      if (affectedA !== affectedB) return affectedA - affectedB;
      if (a.cost.rearrangeCount !== b.cost.rearrangeCount) return a.cost.rearrangeCount - b.cost.rearrangeCount;
      return String(a.optionId).localeCompare(String(b.optionId));
    });
  return {
    best: ranked[0] || null,
    secondBest: ranked[1] || null,
    originalNotRecommendedReason: ranked.some((o) => o.type === 'AS_PROPOSED') ? '' : '原方案有 hard conflict',
    confirmationNeeded: (ranked.filter((o) => o.requiresConfirmation)[0] || {}).title || '',
    recommendationReason: buildRecommendationReason_(ranked[0] || null, profile),
    ranked: ranked
  };
}

function limitRankedForLine_(ranked) {
  const selected = [];
  const seen = {};
  (ranked.ranked || []).forEach((option) => {
    const key = lineStrategyKey_(option);
    if (seen[key] || selected.length >= 3) return;
    seen[key] = true;
    selected.push(Object.assign({}, option, { optionId: optionIdForIndex_(selected.length) }));
  });
  return Object.assign({}, ranked, {
    best: selected[0] || null,
    secondBest: selected[1] || null,
    ranked: selected,
    recommendationReason: ranked.recommendationReason || ''
  });
}

function lineStrategyKey_(option) {
  if (option.type === 'MOVE_EVENT') return 'MOVE_EVENT';
  if (option.type === 'TIME_SHIFT') return 'TIME_SHIFT';
  if (option.type === 'DATE_CHANGE') return 'DATE_CHANGE';
  if (option.type === 'REASSIGN_OWNER') return 'REASSIGN_OWNER';
  if (option.type === 'LEAVE') return 'LEAVE';
  return option.type || '';
}

function optionIdForIndex_(index) {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.charAt(index) || String(index + 1);
}

function dedupeScenarioOptions_(options) {
  const seen = {};
  return (options || []).filter((o) => {
    const key = [
      o.type,
      o.newEvent && o.newEvent.start,
      o.newEvent && o.newEvent.ownerId,
      (o.moves || []).map((m) => [m.from && (m.from.eventId || m.from.routineId || m.from.title), m.to && m.to.start].join('@')).join(','),
      (o.leave && o.leave.personId) || ''
    ].join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function buildPlannedNewEvent_(eventDraft, demand, ownerId) {
  const participantIds = uniqueStrings_((demand.requiredParticipantIds || []).concat(ownerId ? [ownerId] : []));
  return {
    source: 'new',
    title: eventDraft.title,
    start: eventDraft.start,
    end: eventDraft.end,
    participantIds: participantIds,
    ownerId: ownerId || '',
    location: demand.location || eventDraft.location || inferLocationFromText_(eventDraft.title),
    movable: false,
    eventType: 'new'
  };
}

function pickAdultOwner_(baseline, startIso) {
  const adults = adultMembers_(baseline);
  if (!adults.length) return '';
  const free = adults.filter((a) => !isMemberBusy_(a.member_id, startIso, baseline));
  return (free[0] || adults[0]).member_id;
}

function adultMembers_(baseline) {
  return (baseline.members || []).filter((m) =>
    m.role === 'adult' || (!m.requires_adult_companion && /father|mother|adult/.test(m.member_id || '')));
}

function isMemberBusy_(memberId, startIso, baseline) {
  const start = new Date(startIso);
  const probe = { start: formatIso_(start), end: formatIso_(new Date(start.getTime() + 60000)) };
  return (baseline.events || []).some((e) => (e.participantIds || []).indexOf(memberId) !== -1 && detectTimeOverlap(probe, e));
}

function leaveForOwnerIfWorking_(ownerId, event, baseline) {
  const work = (baseline.events || []).filter((e) =>
    isWorkEvent_(e) && (e.participantIds || []).indexOf(ownerId) !== -1 && detectTimeOverlap(event, e));
  if (!work.length) return { hours: 0 };
  const hours = work.reduce((sum, e) => sum + overlapHours_(event, e), 0);
  return { personId: ownerId, personName: memberName_(baseline, ownerId), hours: Math.ceil(hours * 2) / 2 };
}

function isWorkEvent_(event) {
  return event && (event.eventType === 'work' || /工作/.test(event.title || '') || /work/.test(event.routineId || ''));
}

function memberName_(baseline, memberId) {
  const member = (baseline.members || []).filter((m) => m.member_id === memberId)[0];
  return member ? member.name : memberId;
}

function eventDurationMs_(event) {
  return new Date(event.end).getTime() - new Date(event.start).getTime();
}

function overlapHours_(a, b) {
  const start = Math.max(new Date(a.start).getTime(), new Date(b.start).getTime());
  const end = Math.min(new Date(a.end).getTime(), new Date(b.end).getTime());
  return Math.max(0, (end - start) / 3600000);
}

function countCascadeImpacts_(moved, baseline, ignoredEvents) {
  return (baseline.events || []).filter((e) => ignoredEvents.indexOf(e) === -1 && detectTimeOverlap(moved, e)).length;
}

function needsAdultCompanion_(event, baseline) {
  const ids = event.participantIds || [];
  return (baseline.members || []).some((m) => ids.indexOf(m.member_id) !== -1 && m.requires_adult_companion);
}

function hasAdultParticipant_(event, baseline) {
  const ids = event.participantIds || [];
  return adultMembers_(baseline).some((m) => ids.indexOf(m.member_id) !== -1);
}

function shareParticipant_(a, b) {
  const aIds = a.participantIds || [];
  const bIds = b.participantIds || [];
  return aIds.some((id) => bIds.indexOf(id) !== -1);
}

function hasUnknownParticipants_(event) {
  return !(event.participantIds || []).length;
}

function sharesPersonAtDifferentLocation_(a, b) {
  if (!shareParticipant_(a, b)) return false;
  return (a.location || '') && (b.location || '') && a.location !== b.location;
}

function overlapResolvedByLeave_(a, b, leave) {
  if (!leave || !leave.personId || !leave.hours) return false;
  const involvesLeavePerson = (a.participantIds || []).indexOf(leave.personId) !== -1 ||
    (b.participantIds || []).indexOf(leave.personId) !== -1;
  const workInvolved = isWorkEvent_(a) || isWorkEvent_(b);
  return involvesLeavePerson && workInvolved;
}

function uniqueStrings_(values) {
  const seen = {};
  return (values || []).filter((v) => {
    const key = String(v || '');
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function sameCalendarDay_(a, b) {
  return Utilities.formatDate(a, CONFIG.TIMEZONE, 'yyyy-MM-dd') ===
    Utilities.formatDate(b, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function formatShortRange_(event) {
  return formatIsoRange_(event.start, event.end);
}

function reflectOnDecisionOutcome(input) {
  if (!CONFIG.DECISION_OUTCOME_LEARNING_ENABLED) return {};
  const selectedDiffers = input.recommendedOptionId && input.selectedOptionId &&
    input.recommendedOptionId !== input.selectedOptionId;
  return {
    reflectionCandidate: selectedDiffers ? {
      text: '使用者選擇非第一推薦方案時，應記錄為偏好訊號，不直接視為解析錯誤。',
      confidence: 0.7
    } : null,
    profileCandidate: selectedDiffers ? {
      memoryType: 'preference',
      canonicalValue: '使用者在類似衝突中可能偏好 ' + input.selectedOptionId,
      confidence: 0.7,
      status: 'pending'
    } : null
  };
}

/**
 * 偏好回寫：使用者選了「非系統第一推薦」的方案時，視為偏好訊號而非解析錯誤，
 * 把候選寫進 profile_memory / reflection_memory。狀態刻意保守（pending / disabled），
 * 需人工審核後才會進入下次 prompt，避免單一決定就污染記憶。
 */
function learnFromDecisionSelection_(decision, selectedOptionId) {
  const result = reflectOnDecisionOutcome({
    recommendedOptionId: decision.recommended_option_id,
    selectedOptionId: selectedOptionId
  });
  if (!result || (!result.reflectionCandidate && !result.profileCandidate)) return;

  if (result.reflectionCandidate && result.reflectionCandidate.text) {
    appendReflectionMemory({
      groupId: decision.group_id,
      sourceLogId: decision.decision_id,
      triggerType: 'decision_outcome',
      rawText: '',
      reflectionText: result.reflectionCandidate.text,
      memoryStatus: CONFIG.AUTO_MEMORY_ACTIVE ? 'active' : 'disabled'
    });
  }
  if (result.profileCandidate && result.profileCandidate.canonicalValue) {
    appendProfileMemory({
      group_id: decision.group_id,
      subject_id: '',
      memory_type: result.profileCandidate.memoryType,
      canonical_value: result.profileCandidate.canonicalValue,
      evidence_log_ids: safeJsonStringify_([decision.source_log_id].filter(Boolean)),
      source_type: 'inferred_from_decision',
      confidence: result.profileCandidate.confidence,
      status: result.profileCandidate.status || 'pending'
    });
  }
}

function buildDecisionReply_(decisionId, ranked) {
  const lines = ['發現衝突，請選擇方案：'];
  (ranked.ranked || []).slice(0, 3).forEach((option, index) => {
    lines.push(compactDecisionLine_(option, index === 0));
  });
  lines.push('回覆 A、B 或 C');
  return lines.join('\n');
}

function compactDecisionLine_(option, recommended) {
  const prefix = option.optionId + (recommended ? ' 推薦｜' : '｜');
  if (option.type === 'MOVE_EVENT' && (option.moves || []).length) {
    const move = option.moves[0];
    return prefix + eventShortName_(option.newEvent) + '照原時間，' +
      cleanEventTitle_(move.from.title) + '改' + compactRange_(move.to.start, move.to.end);
  }
  if (option.type === 'TIME_SHIFT') {
    return prefix + eventShortName_(option.newEvent) + '改到' +
      compactRange_(option.newEvent.start, option.newEvent.end);
  }
  if (option.type === 'DATE_CHANGE') {
    return prefix + eventShortName_(option.newEvent) + '改到另一日 ' +
      compactRange_(option.newEvent.start, option.newEvent.end);
  }
  if (option.type === 'REASSIGN_OWNER' && (option.reassignments || []).length) {
    return prefix + eventShortName_(option.newEvent) + '改由' + option.reassignments[0].label + '承擔';
  }
  if (option.type === 'LEAVE' && option.leave && option.leave.hours) {
    return prefix + option.leave.personName + '請假處理 ' + eventShortName_(option.newEvent);
  }
  return prefix + option.title;
}

function eventShortName_(event) {
  const title = String(event && event.title || '');
  if (title.indexOf('牙醫') !== -1) return '牙醫';
  return title.slice(0, 12);
}

function cleanEventTitle_(title) {
  return String(title || '').replace(/^\[WHATIF_TEST\]\s*/, '');
}

function compactRange_(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay = Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyy-MM-dd') ===
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const datePart = sameDay ? '' : Utilities.formatDate(start, CONFIG.TIMEZONE, 'M/d ');
  return datePart + Utilities.formatDate(start, CONFIG.TIMEZONE, 'HH:mm') + '–' +
    Utilities.formatDate(end, CONFIG.TIMEZONE, 'HH:mm');
}
