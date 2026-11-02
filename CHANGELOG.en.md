# Changelog

[中文](CHANGELOG.md) | **English**

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [0.1.0] - 2026-11-03

First releasable version.

### Added

- `redmine` SourceKind: configuration card, Policy (numeric user-id allow-list + two admission rows), health entries, worker environment variables, and facts.
- Polling: reverse-order paging with `updated_on:desc,id:desc` plus an `overlapSeconds` cursor window; no server-side time filter (Redmine 2.3 compatible).
  The cursor advances only after a fully successful round; single-item 403/404 is skipped; malformed timestamps/time zones fail the whole round.
- Triggers: issue and journal mapping, `@mention` and assignment detection, skip private notes and the agent’s own comments, stable-id dedupe.
- Context: `threadContext` pagination for `thread` / `root` / `parent`; message ids are `issue:<id>` / `journal:<id>`.
- Images: `<img src="/attachments/...">`, `!file.png!`, `attachment:file.png` → downloaded as model-visible attachments;
  checks model image capability and byte limits; private notes stay out of context.
- Write-back: notes only, hidden marker idempotency, `writeBack` switch, 403/404 recorded as `gone`.
- Ops: read-only probe `scripts/probe-redmine.sh`, install/troubleshooting docs, Docker local integration notes.
- 112 unit/contract/mock-HTTP tests; end-to-end verified on Redmine 6.1 (non-admin agent account).
