# Public Snapshot Policy

This repository (`family-calendar-ai`) is a **public showcase snapshot**. It is
intentionally separate from the private development repository, and it follows
strict rules so that no sensitive data is ever exposed.

## Source of truth

- The **private development repository is the single source of truth** for code,
  full history, configuration, and deployment.
- This public repository is **not** that repo. It contains only anonymized,
  reviewed snapshots intended for reading.

## What gets published here

- A snapshot is published **only after** it passes anonymization **and** a
  secret/PII scan.
- Snapshots are pushed **manually**. There is **no automatic sync** between the
  private repo and this one — nothing is mirrored, and no CI publishes here.
- Before every public update, a **secret / PII scan** is run over the working tree
  (credentials, tokens, API keys, calendar/spreadsheet IDs, emails, phone numbers,
  real names, real schedules, local filesystem paths).

## What is deliberately excluded

This public repository never contains:

- `.clasp.json` (the real Apps Script project id) — only `.clasp.example.json`.
- Script Properties or any secrets (LINE tokens/secret, OpenAI/Gemini keys).
- Real resource IDs (calendar id, spreadsheet id) or webhook/relay endpoints.
- Real family members, ages, addresses, schools, routines, or schedules — all such
  data is replaced with anonymized placeholders.
- Deployment, infrastructure, or private operational details.

## Versioning

- Public version tags (e.g. `v0.1.0-public-snapshot`) mark **showcase snapshots**.
- They **do not** map one-to-one to private development commits, and they are
  **not** production releases. A public tag means "this anonymized snapshot was
  reviewed and is safe to read," not "this is a deployed version."

## If you find exposed data

Open a GitHub issue (without including the sensitive value) or contact the owner
directly. See [../SECURITY.md](../SECURITY.md).
