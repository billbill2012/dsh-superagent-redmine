/**
 * One polling round: validate the account and the project, page the project's recently updated issues newest-first,
 * read the detail of every issue inside the read window, hand its triggers to the host, and advance the cursor only
 * after a round that finished without a failure.
 *
 * The list request never carries a time filter: Redmine 2.3 rejects timestamp filters with a 422 and only accepts
 * day-granular dates, so the version-independent walk is a descending page scan plus a local comparison against the
 * window. Re-reading the overlap is expected — trigger ids are stable, so the engine drops the repeats instead of the
 * plugin having to remember what it already saw.
 */
import { configured, SOURCE, type RedmineConfig } from '../config.ts'
import type { Health, Localized, SourceState, ThreadFact, Trigger } from '../contract.ts'
import { RedmineConfigError, RedmineError, type ClientProvider, type RedmineClient } from './client.ts'
import { offsetMinutes, redmineTime, RedmineTimeZoneError } from './time.ts'
import type { RedmineIssue } from './types.ts'
import { issueUrl, threadKey, triggersOf, type TriggerOptions } from './trigger.ts'

/** Prefix of the persisted read cursor; the full key adds the configured project id. */
export const CURSOR_PREFIX = 'redmine:since:'

/** Server-side page size; Redmine caps `limit` at 100. */
const PAGE_SIZE = 100

/** The cursor key of the configured project. Changing the project therefore starts a fresh history window. */
export function cursorKey(config: RedmineConfig): string {
  return `${CURSOR_PREFIX}${config.projectId}`
}

/** The source-scoped host capabilities one polling round uses. Every port belongs to the host application. */
export interface PollPorts {
  /** Cursor storage, already scoped to this Source by the host. */
  readonly state: SourceState
  /** Hands one trigger to the engine, which de-duplicates by `id`. */
  receive(trigger: Trigger): unknown | Promise<unknown>
  /** Reports health for this plugin's `redmine` entry. */
  report(entry: string, health: Health): void
  /** Publishes the read-only facts of one issue thread for the panel. */
  describe(key: string, description: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void
}

/** Everything a poller needs from its host; injected so a polling round can run without the application. */
export interface PollerOptions {
  /** Current configuration; `undefined` while the Source is switched off. */
  config(): RedmineConfig | undefined
  /** Builds (or returns the cached) client for a configuration. */
  clients: ClientProvider
  /** Clock in epoch milliseconds; injectable so tests can pin the round start. */
  now?: () => number
}

/** What a successful validation learned about the deployment; also the settings card's read-only facts. */
interface Validation {
  /** Normalized base URL plus configured project id; a change invalidates the cache. */
  id: string
  agentId: number
  login: string
  projectNumber: number
  projectName: string
}

/**
 * Drives one Redmine Source: validation, the descending page walk, trigger delivery, the persisted cursor, and the
 * `redmine` health entry. A poller owns the in-memory validation cache only; the cursor lives in host state so a
 * restart resumes where the previous process stopped.
 */
export class RedminePoller {
  private readonly ports: PollPorts
  private readonly options: PollerOptions
  private validation: Validation | undefined
  private consecutiveFailures = 0

  constructor(ports: PollPorts, options: PollerOptions) {
    this.ports = ports
    this.options = options
  }

  /**
   * Runs one polling round. Redmine and network failures never escape: they either leave health quiet (below the
   * configured threshold) or report `error`, and the cursor is only moved by a complete round.
   */
  async poll(signal: AbortSignal): Promise<void> {
    const config = this.options.config()
    if (!config || !configured(config)) {
      // The card is empty or the Source is off. Nothing is fetched, and the stored cursor survives untouched so the
      // history is not replayed when the Source is switched back on.
      this.validation = undefined
      this.consecutiveFailures = 0
      this.ports.report(SOURCE, {
        state: 'paused',
        detail: config ? 'Waiting for the Redmine URL and project' : 'The Redmine source is switched off',
      })
      return
    }
    const started = new Date(this.clock()).toISOString()
    if (signal.aborted) return
    try {
      await this.round(config, started, signal)
    } catch (error) {
      this.fail(config, error, started, signal)
    }
  }

  /** Account and project names learned by the last successful validation, for the settings card. */
  get facts(): Record<string, Localized | string> {
    const config = this.options.config()
    if (!config || !configured(config)) return {}
    const seen = this.validation
    if (!seen || seen.id !== validationId(config)) return {}
    return {
      account: { zh: `以 ${seen.login} 连接`, en: `Connected as ${seen.login}` },
      project: { zh: seen.projectName, en: seen.projectName },
    }
  }

  /** Consecutive failed rounds; reset by a successful round and by pausing. */
  get failures(): number {
    return this.consecutiveFailures
  }

  private clock(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private async round(config: RedmineConfig, started: string, signal: AbortSignal): Promise<void> {
    // A mistyped zone only surfaces when a timestamp without an offset is parsed, which is common on Redmine 2.3.
    // Checking it before any read turns that into an immediate, actionable configuration error.
    if (config.timezone) offsetMinutes(this.clock(), config.timezone)
    const client = this.options.clients(config)
    const validation = await this.validate(client, config, signal)
    if (signal.aborted) return

    const cursor = readCursor(this.ports.state, config)
    const window = cursor === undefined ? Date.parse(started) : Date.parse(cursor) - config.overlapSeconds * 1000

    // Pages arrive newest-first; the walk ends with the last page or once a page reaches past the window. There is
    // deliberately no page cap: a capped walk re-reads the same newest block on every round, so a busy window never
    // drains and its older events are lost while health still says `ready` (see README, "与方案的差异").
    const listed: RedmineIssue[] = []
    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (signal.aborted) return
      const page = await client.issues({ projectId: validation.projectNumber, offset, limit: PAGE_SIZE }, signal)
      listed.push(...page.issues)
      // A short page is the last one; so is a page that reaches `total_count`, which avoids a trailing empty request.
      if (page.issues.length < PAGE_SIZE || offset + page.issues.length >= page.total_count) break
      if (oldestUpdate(page.issues, config.timezone) < window) break
    }

    const listedCount = listed.length
    // Only the ids are needed from here on: the list payloads can be released before the detail reads, so a very busy
    // window costs a few hundred kilobytes of ids rather than holding every issue record in memory.
    const ids = selectWindow(listed, window, config.timezone).map(issue => issue.id)
    listed.length = 0
    const options: TriggerOptions = {
      baseUrl: client.baseUrl,
      projectId: config.projectId,
      agentId: validation.agentId,
      mention: config.mention,
      timezone: config.timezone,
      assigned: config.assigned,
    }
    const skipped: string[] = []
    let read = 0
    let received = 0
    for (const issueId of ids) {
      if (signal.aborted) return
      let detail: RedmineIssue
      try {
        detail = await client.issue(issueId, ['journals', 'attachments'], signal)
      } catch (error) {
        // An issue the account may not read, or one deleted between the list and the detail call, must not block the
        // rest of the round; it is named in the health detail instead (T-17).
        if (error instanceof RedmineError && (error.status === 403 || error.status === 404)) {
          skipped.push(`#${issueId} (${error.status})`)
          continue
        }
        throw error
      }
      read += 1
      const triggers = triggersOf(detail, options, window)
      if (triggers.issue) {
        await this.ports.receive(triggers.issue)
        received += 1
      }
      for (const note of triggers.notes) {
        if (signal.aborted) return
        await this.ports.receive(note)
        received += 1
      }
      this.ports.describe(threadKey(issueId), {
        label: `#${issueId} ${detail.subject}`,
        url: issueUrl(client.baseUrl, issueId),
        facts: threadFacts(detail),
      })
    }

    if (signal.aborted) return
    // The walk reached the end of the window, so everything inside it was delivered: advancing the cursor is safe.
    this.ports.state.set(cursorKey(config), later(cursor, started))
    this.consecutiveFailures = 0
    this.ports.report(SOURCE, { state: 'ready', detail: summary(listedCount, read, received, skipped), at: started })
  }

  /**
   * Resolves the project identifier to its numeric id and learns the account id used for the agent-identity checks.
   * Results are cached per normalized base URL and configured project, so a steady configuration costs two requests
   * once (T-15); a changed URL or project resolves again.
   */
  private async validate(client: RedmineClient, config: RedmineConfig, signal: AbortSignal): Promise<Validation> {
    const id = `${client.baseUrl}\n${config.projectId}`
    const cached = this.validation
    if (cached && cached.id === id) return cached
    this.validation = undefined
    // The project is resolved first: the project endpoint accepts an identifier, but the list endpoint only takes the
    // numeric id, so nothing can be listed before this succeeds.
    const project = await client.project(config.projectId, signal)
    const account = await client.currentUser(signal)
    const validation: Validation = {
      id,
      agentId: account.id,
      login: account.login,
      projectNumber: project.id,
      projectName: project.name,
    }
    this.validation = validation
    return validation
  }

  /** Classifies a failed round: configuration problems are reported at once, transient ones after the threshold. */
  private fail(config: RedmineConfig, error: unknown, started: string, signal: AbortSignal): void {
    // A caller-initiated abort is a pause, not a failed round: no cursor move and no health change.
    if (signal.aborted) return
    this.consecutiveFailures += 1
    if (isConfigurationError(error)) {
      this.validation = undefined
      this.ports.report(SOURCE, { state: 'error', detail: `Redmine configuration error: ${configurationDetail(error)}`, at: started })
      return
    }
    if (this.consecutiveFailures >= config.failuresBeforeError) {
      this.ports.report(SOURCE, { state: 'error', detail: `Redmine polling failed: ${messageOf(error)}`, at: started })
    }
  }
}

/** Identity of a validation snapshot; mirrors `normalizeBaseUrl` without throwing for a URL that is still being typed. */
function validationId(config: RedmineConfig): string {
  return `${config.baseUrl.trim().replace(/\/+$/, '')}\n${config.projectId}`
}

/** Reads the stored cursor as a UTC ISO instant; junk values fall back to the first-run rules rather than stalling. */
function readCursor(state: SourceState, config: RedmineConfig): string | undefined {
  const stored = state.get<string>(cursorKey(config))
  if (typeof stored !== 'string') return undefined
  const at = Date.parse(stored)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

/** The later of the stored cursor and this round's start, which is what gets persisted. */
function later(cursor: string | undefined, started: string): string {
  if (cursor === undefined) return started
  return Date.parse(cursor) > Date.parse(started) ? cursor : started
}

/**
 * The issue's update instant in epoch milliseconds. `updated_on` is optional in the schema, so `created_on` is the
 * fallback. A malformed timestamp fails the round instead of being read as "ancient": treating it as old would silently
 * drop the issue while letting the cursor advance past it, which is exactly the loss NFR-02 forbids.
 */
function updatedAt(issue: RedmineIssue, timezone: string): number {
  const text = issue.updated_on ?? issue.created_on
  let at: number
  try {
    at = Date.parse(redmineTime(text, timezone))
  } catch (error) {
    throw new Error(`Issue #${issue.id} has an unreadable timestamp: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Number.isFinite(at)) throw new Error(`Issue #${issue.id} has an unreadable timestamp: ${text}`)
  return at
}

/** The oldest update instant on a page; the page walk stops once this is before the window. */
function oldestUpdate(issues: readonly RedmineIssue[], timezone: string): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const issue of issues) oldest = Math.min(oldest, updatedAt(issue, timezone))
  return oldest
}

/**
 * Reverses the newest-first pages into ascending order, drops rows updated before the window, and keeps each issue
 * once: an update arriving while the pages are being read can shift a row between offsets.
 */
function selectWindow(listed: readonly RedmineIssue[], window: number, timezone: string): RedmineIssue[] {
  const seen = new Set<number>()
  const selected: RedmineIssue[] = []
  for (const issue of [...listed].reverse()) {
    if (updatedAt(issue, timezone) < window || seen.has(issue.id)) continue
    seen.add(issue.id)
    selected.push(issue)
  }
  return selected
}

/** Status and tracker facts for the thread card; a version or permission may omit either, so missing is just omitted. */
function threadFacts(issue: RedmineIssue): Record<string, ThreadFact | null> {
  const facts: Record<string, ThreadFact | null> = {}
  if (issue.status?.name) facts.status = { label: 'Status', value: issue.status.name }
  if (issue.tracker?.name) facts.tracker = { label: 'Tracker', value: issue.tracker.name }
  return facts
}

/** Health detail of a finished round: how much was read and delivered, and what was skipped. */
function summary(listed: number, read: number, received: number, skipped: readonly string[]): string {
  const parts: string[] = []
  if (listed === 0) {
    // 0 rows is also what an account without `view_issues` sees: say so instead of claiming the project is quiet (B17).
    parts.push('The project returned no issues; if it has issues, the account may lack the "View issues" permission')
  } else {
    parts.push(`Read ${count(read, 'issue')} and received ${count(received, 'trigger')}`)
  }
  if (skipped.length > 0) parts.push(`skipped ${skipped.join(', ')}`)
  return `${parts.join('; ')}.`
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/** Bad URL, missing key, or a project the account cannot see; all of them need the operator, not a retry. */
function isConfigurationError(error: unknown): boolean {
  if (error instanceof RedmineConfigError || error instanceof RedmineTimeZoneError) return true
  return error instanceof RedmineError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422)
}

function configurationDetail(error: unknown): string {
  if (error instanceof RedmineError) {
    switch (error.status) {
      case 401: return 'the API key was rejected (401); check the environment variable named by apiKeyEnv'
      case 403: return 'the account is not allowed to read this project (403)'
      case 404: return 'the project was not found (404); check the configured project id'
      case 422: return `Redmine rejected the request (422): ${error.body}`
    }
  }
  return messageOf(error)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
