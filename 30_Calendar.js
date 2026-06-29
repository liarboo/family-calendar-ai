/**
 * 30_Calendar.gs — Google Calendar 操作
 *
 * 職責：建立與修正行程。Phase 3 的衝突檢查預留在 checkConflicts。
 */

function getCalendar_() {
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!calendar) throw new Error('找不到 Google Calendar，請檢查 GOOGLE_CALENDAR_ID');
  return calendar;
}

/** 建立行程，回傳 { title, eventId } */
function createCalendarEvent(ev) {
  const event = getCalendar_().createEvent(ev.title, ev.start, ev.end);
  event.addPopupReminder(CONFIG.DEFAULT_REMINDER_MINUTES);
  return { title: ev.title, eventId: event.getId() };
}

/** 修正既有行程（標題與時間整組覆蓋為修正後的最終結果） */
function updateCalendarEvent(eventId, ev) {
  const event = getCalendar_().getEventById(eventId);
  if (!event) throw new Error('找不到要修正的行程（可能已被手動刪除）');
  event.setTitle(ev.title);
  event.setTime(ev.start, ev.end);
  return { title: ev.title, eventId: eventId };
}

function updateCalendarTestEventOnly(eventId, ev) {
  const event = getCalendar_().getEventById(eventId);
  if (!event) throw new Error('找不到要移動的測試行程');
  if (event.getTitle().indexOf('[WHATIF_TEST]') !== 0) {
    throw new Error('拒絕移動非 [WHATIF_TEST] 行程');
  }
  event.setTitle(ev.title);
  event.setTime(new Date(ev.start), new Date(ev.end));
  return { title: ev.title, eventId: eventId };
}

/**
 * 衝突檢查：回傳與新行程時段重疊的現有行程清單。
 * 用嚴格重疊判斷（前一個剛好結束、下一個剛好開始不算衝突）。
 */
function checkConflicts(ev) {
  return getCalendar_()
    .getEvents(ev.start, ev.end)
    .filter((e) => e.getEndTime() > ev.start && e.getStartTime() < ev.end)
    .map((e) => ({
      eventId: e.getId(),
      title: e.getTitle(),
      start: formatIso_(e.getStartTime()),
      end: formatIso_(e.getEndTime())
    }));
}

function detectTimeOverlap(a, b) {
  const aStart = new Date(a.start);
  const aEnd = new Date(a.end);
  const bStart = new Date(b.start);
  const bEnd = new Date(b.end);
  return aStart < bEnd && bStart < aEnd;
}

function detectPersonConflict(newEvent, existingEvent) {
  const a = (newEvent.personEntity && newEvent.personEntity.canonicalPersonId) || '';
  const b = (existingEvent.personEntity && existingEvent.personEntity.canonicalPersonId) || '';
  if (!a || !b || a !== b) return null;
  if (!detectTimeOverlap(newEvent, existingEvent)) return null;
  return {
    type: 'PERSON_CONFLICT',
    severity: 'hard',
    eventId: existingEvent.eventId,
    message: '同一人物在同一時間已有行程',
    details: { personId: a }
  };
}

function detectBufferViolation(newEvent, existingEvent, minutes) {
  const bufferMs = (minutes || 15) * 60 * 1000;
  const aStart = new Date(newEvent.start).getTime();
  const aEnd = new Date(newEvent.end).getTime();
  const bStart = new Date(existingEvent.start).getTime();
  const bEnd = new Date(existingEvent.end).getTime();
  const gap = Math.min(Math.abs(aStart - bEnd), Math.abs(bStart - aEnd));
  if (detectTimeOverlap(newEvent, existingEvent) || gap >= bufferMs) return null;
  return {
    type: 'BUFFER_VIOLATION',
    severity: 'soft',
    eventId: existingEvent.eventId,
    message: '新事件與既有事件前後緩衝時間不足',
    details: { bufferMinutes: minutes || 15 }
  };
}

function detectCalendarConflicts(newEvent, options) {
  const opts = options || {};
  const groupId = opts.groupId || '';
  // 既有行程從 listEvents 取出時沒有 personEntity，必須在這裡依 groupId 解析人物，
  // 否則 detectPersonConflict 永遠拿不到 canonicalPersonId、人物衝突形同失效。
  const subject = groupId ? resolveEventPerson_(groupId, newEvent) : newEvent;
  const events = opts.events ? opts.events : listEvents(newEvent.start, newEvent.end);
  const conflicts = [];
  events.forEach((raw) => {
    const existing = groupId ? resolveEventPerson_(groupId, raw) : raw;
    if (detectTimeOverlap(subject, existing)) {
      conflicts.push({
        type: 'TIME_OVERLAP',
        severity: 'hard',
        eventId: existing.eventId,
        message: '新事件與既有事件時間重疊',
        details: {
          existingTitle: existing.title,
          existingStart: existing.start,
          existingEnd: existing.end
        }
      });
    }
    const personConflict = detectPersonConflict(subject, existing);
    if (personConflict) conflicts.push(personConflict);
    const bufferViolation = detectBufferViolation(subject, existing, 15);
    if (bufferViolation) conflicts.push(bufferViolation);
  });
  return conflicts;
}

/** 補上事件的 personEntity（已解析過或無人物可解析時原樣回傳，不變更時間欄位） */
function resolveEventPerson_(groupId, event) {
  if (!event) return event;
  if (event.personEntity && event.personEntity.canonicalPersonId) return event;
  const rawPerson = event.person || event.personText || extractPersonTextFromTitle_(event.title);
  if (!rawPerson) return event;
  return Object.assign({}, event, { personEntity: resolvePersonAlias(groupId, rawPerson) });
}

function revalidateDecisionOption(decision, optionId, options) {
  const eventDraft = safeJsonParse_(decision.event_draft_json, null);
  const selected = safeJsonParse_(decision.options_json, [])
    .filter((o) => o.optionId === optionId)[0];
  if (!eventDraft || !selected) return { valid: false, reason: 'missing_decision_option' };

  const conflicts = detectCalendarConflicts({
    title: eventDraft.title,
    start: new Date(eventDraft.start),
    end: new Date(eventDraft.end)
  }, Object.assign({ groupId: decision.group_id || '' }, options || {}));
  if (selected.type === 'AS_PROPOSED' && conflicts.some((c) => c.severity === 'hard')) {
    return { valid: false, reason: 'calendar_changed', conflicts: conflicts };
  }
  return { valid: true, option: selected, conflicts: conflicts };
}

/** 查詢指定範圍內的行程，依開始時間排序 */
function listEvents(start, end) {
  return getCalendar_()
    .getEvents(start, end)
    .map((e) => ({
      eventId: e.getId(),
      title: e.getTitle(),
      start: formatIso_(e.getStartTime()),
      end: formatIso_(e.getEndTime()),
      location: e.getLocation && e.getLocation() || ''
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ---------------------------------------------------------------- 格式化

/** Date 物件 → ISO 字串版 event（寫入 learning_log 用，與 Gemini 輸出格式一致） */
function toIsoEvent(ev) {
  return {
    title: ev.title,
    start: formatIso_(ev.start),
    end: formatIso_(ev.end)
  };
}

function formatIso_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** LINE 回覆用的人類可讀時間範圍，例：6/12 (Fri) 15:00–16:00 */
function formatRange(ev) {
  return Utilities.formatDate(ev.start, CONFIG.TIMEZONE, 'M/d (EEE) HH:mm') +
    '–' + Utilities.formatDate(ev.end, CONFIG.TIMEZONE, 'HH:mm');
}

/** 同 formatRange，但輸入是 ISO 字串（衝突清單與查詢結果用） */
function formatIsoRange_(startIso, endIso) {
  return formatRange({ start: new Date(startIso), end: new Date(endIso) });
}

/** 查詢回覆的範圍標籤：同一天顯示「6/12 (Fri)」，跨日顯示「6/9 (Mon)–6/15 (Sun)」 */
function formatDayRange_(start, end) {
  const f = (d) => Utilities.formatDate(d, CONFIG.TIMEZONE, 'M/d (EEE)');
  // end 通常是隔日 00:00，往前推 1 毫秒取得實際涵蓋的最後一天
  const lastDay = new Date(end.getTime() - 1);
  const a = f(start);
  const b = f(lastDay);
  return a === b ? a : a + '–' + b;
}
