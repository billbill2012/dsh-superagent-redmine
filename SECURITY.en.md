# Security Policy

[中文](SECURITY.md) | **English**

## Supported versions

`0.1.x` is currently maintained.

## Reporting a vulnerability

- Prefer GitHub **Private vulnerability reporting / Security Advisories** (Repository → Security → Report a vulnerability).
- Or email the maintainer at `billbill@foxmail.com`. Please do **not** open a public issue first.

Include: affected version, reproduction steps, whether credentials or write access are involved, and any suggested fix. We aim to acknowledge within 7 days.

## Security model of this plugin

- **API keys are read only from environment variables** (default `REDMINE_API_KEY`). The settings database stores the *variable name*, never the secret.
- **Least privilege**: use a dedicated Redmine account with only “View issues” and “Add notes” on the target project. Do not use an administrator account.
- **Notes only**: write-back bodies are always `{ issue: { notes } }`. Status, assignee, and custom fields are never changed. With `writeBack=off`, the plugin issues **no** write requests.
- **Idempotency**: notes embed a hidden marker `<!-- dsh-redmine:<messageId> -->` so retries do not create duplicate comments. (This marker string is a wire protocol; do not rename it when renaming directories.)
- **Image download**: only attachment keys that appear in message text are fetched—never arbitrary remote URLs. Byte size is capped by the deployment limit.
- **HTTP risk**: over plain `http://`, the API key travels in cleartext. Use HTTP only on an intranet/VPN; terminate TLS at a reverse proxy when you can.

## Credential exposure

If a key has appeared in chat, logs, screenshots, or commits:

1. Immediately **Reset** the key under Redmine “My account → API access key”; the old key stops working at once;
2. Update the process environment (launchd/plist/tmux/CI secret) with the new key;
3. If history in a repository is involved, follow GitHub secret-scanning guidance, and consider rewriting history.

## Dependencies

Runtime depends only on `zod` (MIT) and Node built-ins. `@deepseek-ai/cordis` is used for types (`import type`) and does not ship in the build output.
