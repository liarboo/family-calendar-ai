/**
 * 80_Research.gs — feature-flagged external research interface.
 */

function classifyResearchNeed(text) {
  const raw = String(text || '');
  if (/營業|開門|關門|天氣|交通|票|價格|費用|規則|醫療|安全|搜尋|查一下/.test(raw)) {
    return { needed: true, reason: 'matched_allowed_need' };
  }
  return { needed: false, reason: 'not_needed' };
}

function anonymizeResearchQuery(input) {
  return String(input || '')
    .replace(/U[a-fA-F0-9]+/g, '[line-user]')
    .replace(/C[a-fA-F0-9]+/g, '[line-group]')
    .replace(/[A-Za-z0-9_-]{20,}/g, '[id]');
}

function runWebResearch(query) {
  if (!CONFIG.WEB_RESEARCH_ENABLED) {
    return { evidenceStatus: 'not_searched', query: anonymizeResearchQuery(query), results: [] };
  }
  return { evidenceStatus: 'not_implemented', query: anonymizeResearchQuery(query), results: [] };
}

function validateResearchResult(result) {
  return result && result.evidenceStatus ? result : { evidenceStatus: 'invalid', results: [] };
}
