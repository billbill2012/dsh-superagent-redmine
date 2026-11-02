/**
 * Minimal Redmine REST client: API-key authentication with a query-parameter fallback, bounded requests, and the
 * handful of endpoints this plugin needs. `fetch` is injected so tests never touch a network.
 */
import { key } from '../key.ts'
import type { RedmineConfig } from '../config.ts'
import { RedmineAttachmentRecordSchema, RedmineCurrentUserSchema, RedmineIssueListSchema, RedmineIssueRecordSchema,
  RedmineProjectSchema, type RedmineAttachment, type RedmineCurrentUser, type RedmineIssue, type RedmineIssueList,
  type RedmineProject } from './types.ts'

export const DEFAULT_TIMEOUT_MS = 30_000

/** A non-2xx Redmine response; `status` is what callers map to skip, gone, or fail. */
export class RedmineError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Redmine responded ${status}${body ? `: ${body}` : ''}`)
    this.name = 'RedmineError'
  }
}

/** The Source is not configured well enough to reach a Redmine instance (missing URL, project, or API key). */
export class RedmineConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedmineConfigError'
  }
}

export interface RedmineConnection {
  baseUrl: string
  apiKey: string
  /** `header` sends `X-Redmine-API-Key`; `query` appends `?key=` for proxies that strip unknown headers. */
  auth: 'header' | 'query'
}

/** Trims the configured root URL: it must be absolute HTTP(S) and its trailing slashes are dropped. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new RedmineConfigError('The Redmine URL is not configured')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new RedmineConfigError(`The Redmine URL is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RedmineConfigError(`The Redmine URL must start with http:// or https://: ${value}`)
  }
  return trimmed
}

/**
 * Resolves the connection for `config`: the API key is read from the environment variable named by `apiKeyEnv`, never
 * from the stored configuration, so no credential is persisted in the settings database.
 */
export function connectionOf(config: RedmineConfig, env: NodeJS.ProcessEnv = process.env): RedmineConnection {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!config.projectId) throw new RedmineConfigError('The Redmine project is not configured')
  if (!config.apiKeyEnv) throw new RedmineConfigError('The environment variable holding the Redmine API key is not configured')
  const apiKey = env[config.apiKeyEnv]?.trim()
  if (!apiKey) throw new RedmineConfigError(`The environment variable ${config.apiKeyEnv} is empty or unset`)
  return { baseUrl, apiKey, auth: 'header' }
}

export interface RedmineClientOptions {
  connection: RedmineConnection
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface IssueQuery {
  projectId: number
  offset?: number
  limit?: number
  status?: string
}

/** The one request shape every page, issue read, and reply uses, including the 401 → `?key=` fallback. */
export class RedmineClient {
  private readonly connection: RedmineConnection
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private auth: RedmineConnection['auth']

  constructor(options: RedmineClientOptions) {
    this.connection = options.connection
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.auth = options.connection.auth
  }

  get baseUrl(): string {
    return this.connection.baseUrl
  }

  /** Whether this client has learned to send the key as a query parameter. */
  get usesQueryAuth(): boolean {
    return this.auth === 'query'
  }

  async currentUser(signal?: AbortSignal): Promise<RedmineCurrentUser> {
    return RedmineCurrentUserSchema.parse(await this.request('/users/current.json', undefined, signal)).user
  }

  /** Resolves an identifier or numeric id to the project record, so `identifier` can be configured. */
  async project(value: string | number, signal?: AbortSignal): Promise<RedmineProject> {
    return RedmineProjectSchema.parse(await this.request(`/projects/${encodeURIComponent(String(value))}.json`, undefined, signal)).project
  }

  async issues(query: IssueQuery, signal?: AbortSignal): Promise<RedmineIssueList> {
    const params = new URLSearchParams({
      project_id: String(query.projectId),
      status_id: query.status ?? '*',
      sort: 'updated_on:desc,id:desc',
      limit: String(query.limit ?? 100),
      offset: String(query.offset ?? 0),
    })
    return RedmineIssueListSchema.parse(await this.request(`/issues.json?${params}`, undefined, signal))
  }

  async issue(id: number, include: readonly string[] = [], signal?: AbortSignal): Promise<RedmineIssue> {
    const query = include.length ? `?include=${encodeURIComponent(include.join(','))}` : ''
    return RedmineIssueRecordSchema.parse(await this.request(`/issues/${id}.json${query}`, undefined, signal)).issue
  }

  async attachment(id: number, signal?: AbortSignal): Promise<RedmineAttachment> {
    return RedmineAttachmentRecordSchema.parse(await this.request(`/attachments/${id}.json`, undefined, signal)).attachment
  }

  /** Writes one note. The body is fixed to `issue.notes`: status, assignee, and custom fields are never sent. */
  async addNote(issueId: number, notes: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/issues/${issueId}.json`, { method: 'PUT', body: JSON.stringify({ issue: { notes } }) }, signal)
  }

  /** Downloads an attachment's bytes, refusing anything larger than `maxBytes`. */
  async download(url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<{ data: Uint8Array; contentType?: string }> {
    const response = await this.fetchChecked(this.contentUrl(url), {}, options.signal)
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`The attachment is ${declared} bytes; the deployment limit is ${options.maxBytes}`)
    }
    // A chunked response carries no trustworthy length, so the body is read incrementally and the limit is enforced as
    // it arrives; buffering first would let one oversized image take the whole process down.
    const data = await readCapped(response, options.maxBytes)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return { data, ...contentType ? { contentType } : {} }
  }

  /**
   * Rewrites an attachment URL onto the configured origin. Older instances generate `content_url` from the request
   * host, so behind nginx or on a multi-domain deployment it may name an internal host that the plugin cannot reach.
   */
  private contentUrl(value: string): string {
    const base = new URL(this.connection.baseUrl)
    const target = new URL(value, base)
    return `${base.origin}${target.pathname}${target.search}`
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchChecked(`${this.connection.baseUrl}${path}`, init, signal)
    if (response.status === 204) return undefined
    const text = await response.text()
    if (!text.trim()) return undefined
    try {
      return JSON.parse(text)
    } catch {
      throw new RedmineError(response.status, `The response is not JSON: ${truncate(text)}`)
    }
  }

  /** Performs the request, retrying once with `?key=` when a header-authenticated request is refused. */
  private async fetchChecked(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const first = await this.attempt(url, init, signal)
    if (first.status !== 401 || this.auth !== 'header') return this.checked(first)
    const second = await this.attempt(url, init, signal, 'query')
    // A 401 that survives the fallback is reported as-is; any other outcome proves which mode the deployment accepts.
    if (second.status !== 401) this.auth = 'query'
    return this.checked(second)
  }

  private async attempt(url: string, init: RequestInit, signal: AbortSignal | undefined, auth = this.auth): Promise<Response> {
    const target = new URL(url)
    if (auth === 'query') target.searchParams.set('key', this.connection.apiKey)
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (auth === 'header') headers.set('X-Redmine-API-Key', this.connection.apiKey)
    const method = (init.method ?? 'GET').toUpperCase()
    if (init.body !== undefined && init.body !== null && JSON_BODY.has(method) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return this.fetchImpl(target, { ...init, headers, signal: within(signal, this.timeoutMs), redirect: 'follow' })
  }

  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response
    const body = await response.text().catch(() => '')
    throw new RedmineError(response.status, truncate(body))
  }
}

/** Caches one client per connection so a learned `?key=` fallback survives across polling rounds. */
export class RedmineClientFactory {
  private readonly clients = new Map<string, RedmineClient>()

  constructor(private readonly options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number } = {}) {}

  get(config: RedmineConfig): RedmineClient {
    const connection = connectionOf(config, this.options.env)
    const id = key('redmine-client', connection.baseUrl, connection.apiKey)
    const cached = this.clients.get(id)
    if (cached) return cached
    const client = new RedmineClient({ connection, ...this.options.fetch ? { fetch: this.options.fetch } : {},
      ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs } })
    this.clients.set(id, client)
    return client
  }

  clear(): void {
    this.clients.clear()
  }
}

/** Supplies a client for a configuration; both the channel and the context reader read config lazily through it. */
export type ClientProvider = (config: RedmineConfig) => RedmineClient

const JSON_BODY = new Set(['PUT', 'POST', 'PATCH'])

/** Combines a caller's cancellation with the request timeout. */
function within(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Reads a response body, refusing to hold more than `maxBytes` in memory. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body
  if (!body) {
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > maxBytes) throw new Error(`The attachment is ${data.byteLength} bytes; the deployment limit is ${maxBytes}`)
    return data
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`The attachment is larger than ${maxBytes} bytes; the deployment limit is ${maxBytes}`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

function truncate(text: string, limit = 600): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
