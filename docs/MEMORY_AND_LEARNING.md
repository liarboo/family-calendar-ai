# Memory & Learning

This project has several distinct "memory" surfaces. They are deliberately
separated, and most learning is **human-in-the-loop**: automatically generated
memories land in a `pending`/`disabled` state and only influence future behavior
after a human enables them. This page inventories every store so you can see
exactly what is wired into the live flow and what is not.

All stores are tabs in one auto-created Google Sheet (`50_Store.js`), except the
pending-conflict cache (CacheService).

---

## 1. Interaction log (`log`)

- **Purpose:** the raw record of every interaction and the source data for all
  learning/debugging.
- **Input:** `logId`, raw text, intent, parsed JSON, final JSON, status,
  `calendarEventId`, `relatedLogId`.
- **Output / read by:** `findLastCalendarLog` (for corrections); decision chains
  via `relatedLogId`.
- **Storage:** `log` tab.
- **Written when:** by the text-message handlers (`appendLog`). Exceptions:
  non-text/non-postback events are ignored without a log row, and the postback
  (A/B/C) path updates `decision_log` rather than appending a new `log` row.
- **Read when:** on each new message (to find the last correctable event).
- **In main flow:** ✅ yes.
- **Production-validated:** ✅ yes (core path).
- **Next:** none; it's the substrate everything else builds on.

## 2. Few-shot examples (`examples`)

- **Purpose:** human-approved input→output pairs injected into the LLM prompt to
  improve parsing of this family's phrasing.
- **Input:** `rawText`, `expectedJson`, `enabled` (checkbox), note.
- **Output:** prompt fragments from `loadFewShotExamples` (only `enabled=true`,
  newest `FEW_SHOT_LIMIT`).
- **Storage:** `examples` tab.
- **Written when:** a user correction auto-creates a candidate with
  `enabled=false` (`appendExampleCandidate`).
- **Read when:** building every prompt (`buildPrompt_`).
- **In main flow:** ✅ yes (gated by the human enabling the row).
- **Production-validated:** ✅ mechanism works; quality depends on curation.
- **Next:** none required; this is the intended minimal feedback loop.

## 3. Profile memory (`profile_memory`)

- **Purpose:** stable household facts — identities, aliases/nicknames,
  relationships, constraints, preferences.
- **Input:** `memory_type`, `subject_id`, `canonical_value`, `variants_json`,
  `rule_json`, `source_type`, `confidence`, `status`.
- **Output:** `buildFamilyProfileSnapshot` → prompt profile text and What-if
  constraints; `resolvePersonAlias` → canonical person for conflict detection.
- **Storage:** `profile_memory` tab.
- **Written when:** after a correction (`extractProfileMemoryCandidates`, LLM
  extraction); when a user states a preference; from non-recommended What-if picks.
- **Read when:** building prompts and the What-if baseline.
- **In main flow:** ✅ yes — but most candidates are written `pending` and require
  human activation (`PROFILE_MEMORY_AUTO_ACTIVE=false` by default; explicit
  statements may auto-activate via `PROFILE_MEMORY_EXPLICIT_AUTO_ACTIVE`).
- **Production-validated:** 🟡 partial — extraction + read paths exist and are
  unit-tested; end-to-end behavior on live household data needs validation.
- **Next:** confirm activation thresholds and dedup (`mergeDuplicateProfileMemories`)
  behave well on real data.

## 4. Reflexion memory (`reflection_memory`)

- **Purpose:** auto-generated one-line "next time" rules after an error or
  correction (the Reflexion pattern).
- **Input:** trajectory + evaluator result → `reflectionText`.
- **Output:** `loadActiveReflectionMemory` → prompt rules (only `active`).
- **Storage:** `reflection_memory` tab.
- **Written when:** an error/correction occurs **and** `REFLEXION_ENABLED=true`
  and the matching trigger flag is on (`maybeCreateReflectionMemory_`).
- **Read when:** building prompts, only if Reflexion is enabled.
- **In main flow:** 🟡 wired but **off by default** (`REFLEXION_ENABLED=false`);
  new memories default to `disabled` unless `AUTO_MEMORY_ACTIVE=true`.
- **Production-validated:** ❌ not validated live.
- **Next:** enable behind a flag on real data, measure whether reflections improve
  parsing before auto-activating.

## 5. Decision log (`decision_log`)

- **Purpose:** the full record of every What-if decision — the audit trail and the
  data source for decision learning.
- **Input:** `event_draft_json`, `conflicts_json`, `options_json`,
  `recommended_option_id`, `selected_option_id`, `final_action_json`, `outcome`,
  `feedback`, `status`.
- **Output:** `getDecisionById` (for postback execution),
  `findLatestDecisionForFeedback` (for outcome capture).
- **Storage:** `decision_log` tab.
- **Written when:** a What-if is presented (`createDecisionRecord`, `pending`),
  then updated to `selected` → `executed` → `closed`.
- **Read when:** a user taps A/B/C, and when a user later reports an outcome.
- **In main flow:** ✅ yes.
- **Production-validated:** ✅ write/read paths tested (TC01 regression suite).
- **Next:** none for logging; the *learning* on top is item 6.

## 6. Decision-outcome learning

- **Purpose:** treat "user picked a non-recommended option" as a **preference
  signal**, not a parse error.
- **Input:** recommended vs. selected option id (`reflectOnDecisionOutcome`).
- **Output:** a `pending`/`disabled` candidate into `reflection_memory` and/or
  `profile_memory`.
- **Storage:** those two tabs.
- **Written when:** the first selection of a non-recommended option
  (`learnFromDecisionSelection_`), and on explicit feedback
  (`tryHandleDecisionFeedback_`).
- **Read when:** only after a human promotes the memory to `active`.
- **In main flow:** 🟡 writes happen; influence requires human review.
- **Production-validated:** 🟡 logic unit-tested; live learning loop not validated.
- **Next:** part of "reflection/memory production integration."

## 7. Family profile & routine model (`family_profile`, `routine_model`)

- **Purpose:** the deterministic substrate for What-if — who the family is and
  what recurs each week.
- **Input:** members (role, work hours, `requires_adult_companion`) and routines
  (weekday, start/end, location, `movable`, `event_type`).
- **Output:** `buildSevenDayBaseline_`, `adultMembers_`, constraint checks.
- **Storage:** `family_profile` / `routine_model` tabs.
- **Written when:** seeded via `seedWhatIfV1Data` (anonymized in this repo).
- **Read when:** every What-if.
- **In main flow:** ✅ yes (when What-if runs).
- **Production-validated:** ✅ via the What-if test suite (on seed data).
- **Next:** a UI/flow to maintain these from chat rather than seeding.

## 8. External research (`80_Research.js`)

- **Purpose:** placeholder for fetching external facts (hours, weather, prices)
  to inform scenarios.
- **Input:** query text (anonymized via `anonymizeResearchQuery`).
- **Output:** `{ evidenceStatus: "not_implemented" \| "not_searched", results: [] }`.
- **Storage:** none.
- **Written/read when:** called during What-if reply assembly; gated by
  `WEB_RESEARCH_ENABLED` (default false).
- **In main flow:** 🟡 called, but returns a stub.
- **Production-validated:** ❌ not implemented.
- **Next:** implement a real, rate-limited, anonymized research call if needed.

## 9. Pending-conflict state (CacheService)

- **Purpose:** the short-lived "I asked about a conflict and I'm waiting for your
  answer" state that powers the natural-language resolution loop.
- **Input:** the new event + conflicting events + source `logId`.
- **Output:** consumed by `handleResolve_`.
- **Storage:** CacheService, TTL `PENDING_TTL_MINUTES` (15).
- **Written when:** a simple-path conflict is detected (`savePendingConflict`).
- **Read when:** the next message arrives (`getPendingConflict`).
- **In main flow:** ✅ yes.
- **Production-validated:** ✅ core path.
- **Next:** none.

---

## Summary

| Store | In main flow | Production-validated |
|---|---|---|
| `log` | ✅ | ✅ |
| `examples` (few-shot) | ✅ (human-gated) | ✅ mechanism |
| `profile_memory` | ✅ (mostly pending) | 🟡 partial |
| `reflection_memory` | 🟡 off by default | ❌ |
| `decision_log` | ✅ | ✅ |
| decision-outcome learning | 🟡 writes only | 🟡 |
| `family_profile` / `routine_model` | ✅ | ✅ (seed) |
| external research | 🟡 stub | ❌ |
| pending-conflict cache | ✅ | ✅ |

**Honest framing:** the logging, few-shot, decision-log, and conflict-loop paths
are real and exercised. The *autonomous* learning surfaces (reflexion, profile
auto-activation, decision-outcome learning) exist as wired modules but are
deliberately conservative and not yet validated on live data — this is **not** a
fully autonomous self-learning system.
