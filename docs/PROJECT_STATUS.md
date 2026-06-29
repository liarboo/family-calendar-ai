# Project Status

A working prototype and personal portfolio piece. This page is the honest,
single-source status — it does **not** overstate anything that hasn't been
verified.

> Legend — ✅ Verified (code + deterministic test) · 🟡 Partial (module exists,
> integration/activation/validation incomplete) · 🔭 Planned (not built) ·
> ⚠️ Known risk.

## Verified ✅

- LINE webhook handling + byte-accurate signature verification.
- LLM intent parsing (`create` / `correction` / `query` / `resolve` / `none`) with
  provider fallback (**default Gemini**; optional OpenAI-primary → Gemini
  fallback), strict JSON validation.
- **What-if V1 engine**: 7-day baseline, six scenario types, hard-constraint
  elimination, deterministic cost ranking with preference boost — covered by the
  What-if and TC01 deterministic test suites.
- `create` requests routed through What-if **before** any calendar write (TC01).
- Stale `AS_PROPOSED` option rejected when the live calendar changed.
- Top-3 compact A/B/C decision reply.
- Time-overlap conflict detection.
- Decision logging for every What-if.

Working but not directly unit-tested (see README "Implemented"): LINE signature
verification (only signature *generation* is exercised by a test), person/buffer
conflict detection, the conflict-resolution pending loop, last-event correction,
postback **execution** (move execution limited to `[WHATIF_TEST]` events), and
few-shot capture/reuse. Calendar **create** is covered by a live **integration**
test; update/list are not directly tested.

## Partial 🟡

- **Profile memory**: extraction on corrections and read paths are tested, but
  most candidates are written `pending`; live-data activation behavior is not yet
  validated.
- **Reflexion memory**: full module, **off by default** (`REFLEXION_ENABLED=false`);
  not validated in production.
- **Decision-outcome learning**: a non-recommended pick is recorded as a
  preference signal, but only as a `pending`/`disabled` candidate needing human
  review.
- **`update` / `delete` intents**: recognized by the LLM, handled by a
  "not implemented" stub.

## Planned 🔭 — the four open development items

1. **Postback idempotency** — a retried LINE postback can re-execute and create a
   duplicate event; needs an idempotency key per decision/option.
2. **Routine sacrifice / opportunity-cost model** — replace the current weighted-sum
   cost with a real estimate of which routine is cheapest to give up.
3. **Forward 7-day minimum-cost slot scan** — exhaustive search for the cheapest
   constraint-satisfying open slot across the week (today only a few forward
   candidate slots are proposed).
4. **Reflection / memory production integration** — validate the learning loop
   end-to-end on live, non-seed data before enabling auto-activation.

## Known risks ⚠️

- **Duplicate postback → duplicate event** (item 1 above). Known defect.
- Every inbound message triggers an LLM call (cost + latency).
- Conflict reasoning assumes one shared calendar; person-level conflicts depend on
  correct profile/alias data.

## Testing notes

`90_Tests.js` runs inside the Apps Script environment (it uses `CalendarApp`,
`PropertiesService`, `SpreadsheetApp`, etc., so it is not Node-runnable). It mixes
two kinds of functions: **deterministic logic tests** (What-if generation,
elimination, ranking, routing, alias resolution, the TC01 regressions) and
**live integration / diagnostic** functions that call real APIs and may create a
real calendar event or log resource IDs (`testCreateCalendarEvent`,
`testGeminiApi`, `testLineProperties`, `testLineAccessToken`) — run those only
against a throwaway/test calendar. All committed `.js` files pass `node --check`
syntax validation.

## Data & privacy

This is a public, anonymized snapshot. Seed data and fixtures use placeholder
people (`家長A` / `家長B` / `孩子A` / `孩子B`) and generic districts
(`住家區` / `市區`). No real personal data, credentials, or resource IDs are in
this repository or its history. See [../SECURITY.md](../SECURITY.md).
