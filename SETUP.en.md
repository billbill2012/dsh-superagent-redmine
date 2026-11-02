# Setup and go-live

[中文](SETUP.md) | **English**

> Expanded deployment notes for [README.en.md](README.en.md). Design and acceptance criteria live in the monorepo at `docs/dsh-superagent-redmine/` (Chinese-first; not published with this package).

## 0. Prerequisites

| Dependency | Requirement |
|---|---|
| Node.js | ≥ 22.19 or ≥ 24 (built-in `fetch`) |
| DSH | Local `dsh --version` matches `package.json` `engines.dsh` (`^0.2.1-rc.3`) |
| dsh-superagent | Local checkout (e.g. `~/src/dsh-superagent`) with **its own setup finished** (GitHub repo + agent CLI) |
| Redmine | 2.3+; a dedicated API account with “View issues” + “Add notes” on the project |
| Credentials | That account’s API key in an environment variable (default `REDMINE_API_KEY`) |

When `ctx.configured()` is false the host polls no Sources: the card shows `paused`. That is not a plugin fault.

## 1. Build

```sh
cd <plugin-repo-root>     # skip if you are already there
pnpm install
pnpm check                # typecheck + tests + build → lib/index.js and lib/index.d.ts
```

## 2. Install into the profile

```sh
dsh plugin --profile superagent add "link:$PWD"
```

Then edit `~/.dsh/profiles/superagent/cordis.patch.yml` and **append** an insert at the end (profile patches stack; new plugins must use `insert`—a bare `- id:` is treated as editing an existing entry):

```yaml
- insert:
    - id: dsh-superagent-redmine
      name: dsh-superagent-redmine
```

## 3. Provide the API key

How to obtain it (screenshot + steps): see [README “Getting a Redmine API key”](README.en.md#getting-a-redmine-api-key)—**My account → API access key → Show/Reset**, copy the 40-character key.

```sh
export REDMINE_API_KEY=xxxxxxxxxxxxxxxx
```

On Redmine 2.3, if `/users/current.json` returns 404, ask an admin to enable REST API under **Administration → Settings → API**.

The key must be visible to **the process that starts DSH**: tmux sessions inherit the shell that started tmux; launchd/Finder-started processes do not inherit terminal `export`s—put the variable in a launchd plist or startup script. The plugin reads the variable name only and **never writes the key into the settings database**.

## 4. Restart and verify extension points

```sh
cd ~/src/dsh-superagent && scripts/dsh-superagent restart
scripts/dsh-superagent status; echo "status=$?"     # expect 0
```

- Settings → Sources should show a **Redmine** card;
- Opening the card with empty config **must not error**—every field has a default, so `schema.parse({})` does not throw;
- The panel’s “execution environment” should list `DSH_SUPERAGENT_REDMINE_URL` / `_PROJECT` / `_ISSUE`.

## 5. Configure and watch the first poll

1. Set `baseUrl` (e.g. `http://redmine.example.com`) and `projectId` (identifier or numeric id), then save;
2. The first poll validates in order: `GET /users/current.json` (account), `GET /projects/<projectId>.json` (visibility, and resolve identifier → numeric id). Failures write an `error` health entry with a reason and create no tickets;
3. On success the card shows **Connected as &lt;login&gt;** and the project name (facts), health becomes `ready`, and details include issues read and triggers received this round;
4. Create a Redmine issue containing `@dsh`; a Ticket should appear within ≤ 2 poll intervals;
5. Add that user’s **numeric user id** in Policy (`/users/<id>` in the profile URL), or the request is dropped as “outside the allow-list”.

## 6. Read-only probe before go-live (recommended)

```sh
export REDMINE_URL=http://redmine.example.com
export REDMINE_API_KEY=...
export REDMINE_PROJECT=my-project
./scripts/probe-redmine.sh
```

GET only: account, project visibility, visible issue count, whether timestamp filters work (422 on 2.3 is expected), real timestamp shapes, journals/attachments shape, `content_url`, and `?key=` fallback. **Do not** use it to write issues.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Card stuck `paused`, detail “Waiting for the deployment check” | dsh-superagent’s own setup is incomplete (GitHub repo + agent CLI); finish that first |
| `error`: `The environment variable REDMINE_API_KEY is empty or unset` | Key not visible to the DSH process; see §3 |
| `error`: `Redmine responded 401` | Invalid/expired key; confirm the account can log in |
| `error`: `Redmine responded 404` (project) | Wrong identifier, or the account cannot see the project (2.3 returns 401/404 for invisible projects) |
| `ready` but 0 issues while the project has issues | Role lacks “View issues”; known 2.3 behavior (requests with `project_id` may not 403) |
| Images unreadable | `/attachments/:id.json` or download 403: confirm the account can see attachments; the plugin reports “image unreadable” without failing Eval |
| Only old comments / missing new ones | Check `overlapSeconds` / `pollSeconds`; after restart the cursor restores from KV and does not backfill history. For long batches, temporarily lower overlap/poll |
| Private notes appear as tickets | Redmine **2.6–3.3** has private notes but the API omits `private_notes`; upgrade to 3.4+ or agree not to treat private notes as requests |
| Cannot reach Redmine | Plain HTTP: key in cleartext—intranet/VPN only; terminate TLS at a reverse proxy when possible |
| Reverse proxy strips `X-Redmine-API-Key` | After 401 the plugin falls back to `?key=` and caches that mode |

## 8. Uninstall

```sh
dsh plugin --profile superagent remove dsh-superagent-redmine
```

Remove the matching `insert` from `cordis.patch.yml`. Existing Triggers/Tickets and Redmine notes are left in place.
