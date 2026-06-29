# Security & Privacy

## Secret handling

- **No secrets are committed.** Every key and resource id is read at runtime from
  Apps Script **Script Properties** in `00_Config.js`:
  `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`,
  `OPENAI_API_KEY`, `GOOGLE_CALENDAR_ID`, and the auto-stored `LEARNING_SHEET_ID`.
  These are variable reads, not literals.
- **`.clasp.json` is gitignored** because it holds a real Apps Script project id.
  Use `.clasp.example.json` as a template.
- **Error logs are scrubbed.** `redactSecrets_` (`20_Llm.js`) removes `key=…` and
  `Bearer …` tokens before anything is logged, and `handleFatalError_` scrubs the
  user-facing reply. Note one deployment boundary: `doPost`'s HTTP JSON error
  response returns the raw error message to the relay caller — keep that relay
  trusted and don't surface its responses publicly.
- **Webhook authenticity** is enforced with a byte-accurate HMAC-SHA256 over the
  raw request body (`verifyLineSignature`, `40_Line.js`); can be toggled with
  `VERIFY_SIGNATURE`.
- **Research queries are anonymized** (`anonymizeResearchQuery`, `80_Research.js`)
  — LINE user/group ids and long tokens are stripped before any external call.

## Privacy / anonymization of this public repo

This repository is a **public, anonymized snapshot**, published as a fresh
single-commit repo specifically so that no earlier private history is exposed.

All household data in seed files, test fixtures, prompts, and examples uses
**placeholders**:

| Real-world concept | Placeholder used here |
|---|---|
| Family members | `家長A`, `家長B`, `孩子A`, `孩子B` |
| Nicknames | generic (e.g. `妞妞`) |
| Home district | `住家區` |
| Work / school district | `市區` |

No **real** names, addresses, schools, phone numbers, emails, calendar ids, or
spreadsheet ids appear in this repository. The seed data does contain illustrative
**synthetic** ages and routine times (e.g. `age_years: 5`, a fictional work /
school / commute / bedtime schedule) used purely to demonstrate the What-if
engine — these are made-up, not anyone's real schedule. This repo is published as
a single clean commit, so no earlier private history accompanies it. A
pre-publication scan confirmed no credentials of any kind are present.

> [!NOTE]
> The diagnostic functions in `90_Tests.js` (`testLineProperties`,
> `testCreateCalendarEvent`, …) print resource ids / a created event id to the
> Apps Script execution log when run. No value is committed, but don't paste those
> execution logs publicly.

## Reporting a vulnerability

This is a personal portfolio project. If you spot a security issue or
accidentally exposed data, please open a GitHub issue (omit any sensitive
details) or contact the repository owner directly.

## If you deploy your own copy

- Set all secrets in Script Properties; never hardcode them.
- Keep `VERIFY_SIGNATURE=true` in production.
- Seed `family_profile` / `routine_model` with **your own** data — and remember it
  becomes personal data; keep that deployment private.
- Note the known **postback idempotency** gap (see
  [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)) before relying on it for
  irreversible actions.
