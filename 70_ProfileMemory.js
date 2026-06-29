/**
 * 70_ProfileMemory.gs — household facts, aliases, and stable preferences.
 */

const PROFILE_MEMORY_TYPES = ['identity', 'alias', 'relationship', 'constraint', 'preference'];
const PROFILE_MEMORY_STATUSES = ['pending', 'active', 'rejected', 'superseded'];

function extractProfileMemoryCandidates(input) {
  if (!CONFIG.PROFILE_MEMORY_ENABLED) {
    console.log('Profile extraction skipped: PROFILE_MEMORY_ENABLED=false');
    return [];
  }

  let parsed = { candidates: [] };
  try {
    parsed = parseJsonLoose_(callLlmRawWithFallback_(buildProfileExtractionPrompt_(input)).text);
  } catch (err) {
    console.log('Profile extraction failed: ' + shortError_(err));
    return [];
  }

  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const kept = candidates
    .map((c) => normalizeProfileCandidate_(c, input))
    .filter((c) => c && c.confidence >= 0.65);
  // 觀測點：LLM 給了幾個候選 vs 通過 schema/confidence 門檻幾個。
  // parsed>0 但 kept=0 代表 LLM 輸出不符 schema（最常見：缺 confidence 或 memoryType 不在白名單）。
  console.log('Profile extraction: parsed=' + candidates.length + ' kept=' + kept.length);

  return kept
    .map((c) => {
      appendProfileMemory({
        group_id: input.groupId,
        subject_id: c.subjectId,
        memory_type: c.memoryType,
        canonical_value: c.canonicalValue,
        variants_json: safeJsonStringify_(c.variants || []),
        rule_json: safeJsonStringify_(c.rule || {}),
        evidence_log_ids: safeJsonStringify_([input.sourceLogId].filter(Boolean)),
        source_type: c.sourceType,
        confidence: c.confidence,
        status: profileCandidateStatus_(c)
      });
      return c;
    });
}

function buildProfileExtractionPrompt_(input) {
  return [
    '你是家庭行事曆 bot 的 profile memory 擷取器。',
    '從使用者的原始訊息與後續修正中，擷取穩定的家庭事實、人物別名、關係、限制或偏好。',
    '只輸出 JSON：{"candidates":[...]}，不要 markdown、不要解釋。',
    '每個 candidate 物件「必須」包含以下全部欄位（缺一不可，否則會被丟棄）：',
    '- memoryType：只能是 identity / alias / relationship / constraint / preference 之一',
    '- subjectId：人物的穩定識別碼，同一人多次出現要用同一個（可用英文代號，如 daughter_02）',
    '- canonicalValue：這條記憶的標準值（人物別名請填「本名」，例：孩子B）',
    '- variants：別名／暱稱字串陣列（例：["小女兒"]），沒有就給 []',
    '- sourceType：explicit_statement（使用者明講）或 inferred_from_event（單一事件推論）',
    '- confidence：0~1 的數字，使用者明確陳述請給 0.9 以上（這個欄位必填，否則記憶會被忽略）',
    '- reason：一句話說明依據',
    '單一事件推論出的 preference 必須 sourceType="inferred_from_event"。',
    '找不到任何穩定記憶時，輸出 {"candidates":[]}。',
    '',
    '範例：輸入「小女兒就是孩子B」應輸出：',
    '{"candidates":[{"memoryType":"alias","subjectId":"daughter_02","canonicalValue":"孩子B",' +
      '"variants":["小女兒"],"sourceType":"explicit_statement","confidence":0.95,"reason":"使用者明確指出小女兒的本名"}]}',
    '',
    'rawText: ' + input.rawText,
    'originalParsedResult: ' + safeJsonStringify_(input.originalParsedResult || {}),
    'correctionText: ' + (input.correctionText || ''),
    'finalCorrectResult: ' + safeJsonStringify_(input.finalCorrectResult || {})
  ].join('\n');
}

function normalizeProfileCandidate_(candidate) {
  const memoryType = String(candidate.memoryType || '');
  const confidence = Number(candidate.confidence || 0);
  if (PROFILE_MEMORY_TYPES.indexOf(memoryType) === -1) return null;
  return {
    memoryType: memoryType,
    subjectId: String(candidate.subjectId || '').trim(),
    canonicalValue: String(candidate.canonicalValue || '').trim(),
    variants: Array.isArray(candidate.variants) ? candidate.variants.map(String) : [],
    rule: candidate.rule || {},
    sourceType: String(candidate.sourceType || 'user_correction'),
    confidence: confidence,
    reason: String(candidate.reason || '')
  };
}

function profileCandidateStatus_(candidate) {
  if (candidate.confidence < 0.9) return 'pending';
  if (candidate.sourceType === 'inferred_from_event') return 'pending';
  if (candidate.memoryType === 'preference') return 'pending';
  if (candidate.sourceType === 'explicit_statement' && CONFIG.PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE) {
    return 'active';
  }
  return CONFIG.PROFILE_MEMORY_AUTO_ACTIVE ? 'active' : 'pending';
}

function resolvePersonAlias(groupId, rawPersonText) {
  const raw = String(rawPersonText || '').trim();
  if (!raw) return { status: 'empty', rawPersonText: raw };

  const familyMatches = findFamilyProfilesByGroup(groupId)
    .filter((m) => {
      const aliases = safeJsonParse_(m.aliases_json, []);
      return m.name === raw || aliases.indexOf(raw) !== -1;
    })
    .map((m) => ({
      subject_id: m.member_id,
      canonical_value: m.name,
      variants_json: m.aliases_json
    }));
  const memoryMatches = loadRelevantProfileMemories(groupId)
    .filter((m) => m.memory_type === 'alias' || m.memory_type === 'identity')
    .filter((m) => {
      const variants = safeJsonParse_(m.variants_json, []);
      return m.canonical_value === raw || variants.indexOf(raw) !== -1;
    });
  const matches = familyMatches.concat(memoryMatches);

  const subjectIds = {};
  matches.forEach((m) => { subjectIds[m.subject_id] = true; });
  if (Object.keys(subjectIds).length > 1) {
    return { status: 'ambiguity', rawPersonText: raw, matches: matches };
  }
  if (!matches.length) return { status: 'unresolved', rawPersonText: raw };

  return {
    status: 'resolved',
    rawPersonText: raw,
    canonicalPersonId: matches[0].subject_id,
    canonicalPersonName: matches[0].canonical_value
  };
}

function normalizeEventEntities(groupId, event) {
  const copy = Object.assign({}, event || {});
  const rawPerson = copy.person || copy.personText || extractPersonTextFromTitle_(copy.title);
  if (!rawPerson) return copy;
  copy.personEntity = resolvePersonAlias(groupId, rawPerson);
  return copy;
}

function extractPersonTextFromTitle_(title) {
  const text = String(title || '');
  const match = text.match(/(大女兒|小女兒|女兒|兒子|爸爸|媽媽|太太|先生|姐姐|哥哥|弟弟|妹妹)/);
  return match ? match[1] : '';
}

function buildFamilyProfileSnapshot(groupId) {
  const snapshot = { people: [], aliases: [], constraints: [], preferences: [] };
  findFamilyProfilesByGroup(groupId).forEach((m) => {
    const item = {
      subjectId: m.member_id,
      canonicalValue: m.name,
      variants: safeJsonParse_(m.aliases_json, []),
      rule: {
        role: m.role,
        ageYears: m.age_years,
        homeLocation: m.home_location,
        workLocation: m.work_location,
        weekdayStart: m.weekday_start,
        weekdayEnd: m.weekday_end,
        requiresAdultCompanion: m.requires_adult_companion === true || m.requires_adult_companion === 'TRUE'
      }
    };
    snapshot.aliases.push(item);
    snapshot.people.push({ subjectId: item.subjectId, name: item.canonicalValue, rule: item.rule });
    if (item.rule.requiresAdultCompanion) {
      snapshot.constraints.push({
        subjectId: item.subjectId,
        canonicalValue: item.canonicalValue + '外出、接送、就醫或照護需要成人陪同',
        rule: { requiresAdultCompanion: true }
      });
    }
  });
  loadRelevantProfileMemories(groupId).forEach((m) => {
    const item = {
      subjectId: m.subject_id,
      canonicalValue: m.canonical_value,
      variants: safeJsonParse_(m.variants_json, []),
      rule: safeJsonParse_(m.rule_json, {})
    };
    if (m.memory_type === 'alias' || m.memory_type === 'identity' || m.memory_type === 'relationship') {
      snapshot.aliases.push(item);
      if (snapshot.people.map((p) => p.subjectId).indexOf(item.subjectId) === -1) {
        snapshot.people.push({ subjectId: item.subjectId, name: item.canonicalValue });
      }
    } else if (m.memory_type === 'constraint') {
      snapshot.constraints.push(item);
    } else if (m.memory_type === 'preference') {
      snapshot.preferences.push(item);
    }
  });
  return snapshot;
}
