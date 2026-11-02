/**
 * Polling rounds: project resolution, the descending page walk, cursor persistence, trigger delivery, and health.
 *
 * Every round is pinned to a fixed clock and served by a scripted `fetch`, so no test touches Redmine or the wall
 * clock. The fake ports mirror the host: state writes, receives, describes, and health reports are all recorded.
 */
import { describe, expect, it } from 'vitest'
import { RedmineConfigSchema, type RedmineConfig } from '../src/config.ts'
import type { Health, SourceState, Trigger } from '../src/contract.ts'
import { RedmineClient, connectionOf } from '../src/redmine/client.ts'
import { CURSOR_PREFIX, RedminePoller, cursorKey, type PollPorts } from '../src/redmine/poll.ts'
import type { RedmineIssue, RedmineJournal } from '../src/redmine/types.ts'
import { fakeFetch, type FakeNetwork, type FakeReply, type FakeRequest } from './helpers/fetch.ts'
import { issue, journal } from './helpers/fixtures.ts'

const BASE = 'http://redmine.test'
const ENV = { REDMINE_API_KEY: 'secret-key' }
/** Round start of the first poll in almost every test. */
const START = Date.parse('2026-11-02T10:00:00Z')
/** A page size the poller and the fake server must agree on. */
const PAGE_SIZE = 100

const PROJECT = { project: { id: 42, identifier: 'dsh-test', name: 'DSH Test' } }
const USER = { user: { id: 9, login: 'dsh-agent', firstname: 'DSH', lastname: 'Agent' } }

type DescribeInput = Parameters<PollPorts['describe']>[1]
type FakeState = SourceState & { readonly values: Map<string, unknown> }

/** Scripted Redmine server: the list is newest-first, details are looked up by issue id, and overrides inject failures. */
interface Server {
  issues: RedmineIssue[]
  details: Map<number, RedmineIssue>
  list?: (offset: number, index: number) => FakeReply | undefined
  detail?: (id: number) => FakeReply | undefined
  project?: () => FakeReply | undefined
  user?: () => FakeReply | undefined
  totalCount?: number
}

interface Store {
  readonly state: FakeState
  readonly writes: { key: string; value: unknown }[]
}

interface WorldOptions {
  config?: Partial<RedmineConfig>
  now?: number
  cursor?: string
  issues?: RedmineIssue[]
  details?: RedmineIssue[]
  store?: Store
  /** Runs after a trigger is recorded, which lets a test abort from inside `receive`. */
  receive?: (trigger: Trigger) => void
  /** When true, every header-authenticated request is refused, so the client must learn the ?key= fallback. */
  stripHeaderAuth?: boolean
}

function createStore(initial: Record<string, unknown> = {}): Store {
  const values = new Map<string, unknown>(Object.entries(initial))
  const writes: { key: string; value: unknown }[] = []
  const state: FakeState = {
    values,
    get<V>(key: string): V | undefined {
      return values.get(key) as V | undefined
    },
    set<V>(key: string, value: V | undefined): void {
      writes.push({ key, value })
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
  return { state, writes }
}

/** One poller wired to recording ports, a scripted network, and a mutable clock/config. */
class World {
  readonly network: FakeNetwork
  readonly server: Server
  readonly store: Store
  readonly triggers: Trigger[] = []
  readonly reports: { entry: string; health: Health }[] = []
  readonly describes: { key: string; description: DescribeInput }[] = []
  readonly poller: RedminePoller
  now: number
  config: RedmineConfig | undefined
  private listCalls = 0
  private stripHeaderAuth: boolean

  constructor(init: WorldOptions = {}) {
    this.server = { issues: init.issues ?? [], details: new Map((init.details ?? []).map(item => [item.id, item] as const)) }
    this.store = init.store ?? createStore()
    this.now = init.now ?? START
    this.stripHeaderAuth = init.stripHeaderAuth ?? false
    this.config = RedmineConfigSchema.parse({ baseUrl: BASE, projectId: 'dsh-test', ...init.config })
    if (init.cursor !== undefined) this.store.state.values.set(cursorKey(this.config), init.cursor)
    this.network = fakeFetch(request => this.route(request))
    this.poller = new RedminePoller({
      state: this.store.state,
      receive: trigger => {
        this.triggers.push(trigger)
        init.receive?.(trigger)
      },
      report: (entry, health) => {
        this.reports.push({ entry, health })
      },
      describe: (key, description) => {
        this.describes.push({ key, description })
      },
    }, {
      config: () => this.config,
      clients: config => new RedmineClient({ connection: connectionOf(config, ENV), fetch: this.network.fetch }),
      now: () => this.now,
    })
  }

  async poll(signal?: AbortSignal): Promise<void> {
    await this.poller.poll(signal ?? new AbortController().signal)
  }

  get writes(): { key: string; value: unknown }[] {
    return this.store.writes
  }

  /** List requests in order. */
  get lists(): FakeRequest[] {
    return this.network.requests.filter(request => request.url.pathname === '/issues.json')
  }

  /** Ids of the detail requests in order. */
  detailIds(): number[] {
    return this.network.requests.flatMap(request => {
      const match = /^\/issues\/(\d+)\.json$/.exec(request.url.pathname)
      return match ? [Number(match[1])] : []
    })
  }

  cursor(): unknown {
    return this.config ? this.store.state.values.get(cursorKey(this.config)) : undefined
  }

  private route(request: FakeRequest): FakeReply | undefined {
    if (this.stripHeaderAuth && request.headers.has('X-Redmine-API-Key')) return { status: 401, text: 'Unauthorized' }
    const path = request.url.pathname
    if (path === '/users/current.json') return this.server.user ? this.server.user() : { body: USER }
    if (path.startsWith('/projects/')) return this.server.project ? this.server.project() : { body: PROJECT }
    if (path === '/issues.json') {
      const index = this.listCalls++
      const offset = Number(request.url.searchParams.get('offset') ?? '0')
      const override = this.server.list?.(offset, index)
      if (override) return override
      const page = this.server.issues.slice(offset, offset + PAGE_SIZE)
      return { body: { issues: page, total_count: this.server.totalCount ?? this.server.issues.length, offset, limit: PAGE_SIZE } }
    }
    const match = /^\/issues\/(\d+)\.json$/.exec(path)
    if (match) {
      const id = Number(match[1] ?? '')
      const override = this.server.detail?.(id)
      if (override) return override
      const detail = this.server.details.get(id)
      return detail ? { body: { issue: detail } } : { status: 404, text: 'Not Found' }
    }
    return undefined
  }
}

/** Epoch milliseconds → ISO string; the fixtures use the same clock as the injected `now`. */
const at = (ms: number): string => new Date(ms).toISOString()
/** Seconds relative to the first round start → ISO string. */
const seconds = (offset: number): string => at(START + offset * 1000)

function listIssue(id: number, updated: number, created = -3600): RedmineIssue {
  return issue(id, { created_on: seconds(created), updated_on: seconds(updated) })
}

function detailIssue(id: number, options: { created?: number; updated?: number; journals?: RedmineJournal[] } = {}): RedmineIssue {
  return issue(id, {
    created_on: seconds(options.created ?? -3600),
    updated_on: seconds(options.updated ?? 0),
    journals: options.journals ?? [],
  })
}

function note(id: number, offset: number, notes = '@dsh fix this'): RedmineJournal {
  return journal(id, { created_on: seconds(offset), notes })
}

describe('configuration', () => {
  it('reports paused and leaves the cursor alone while the URL and project are missing', async () => {
    const world = new World({ config: { baseUrl: '', projectId: '' }, cursor: seconds(-60) })
    await world.poll()
    expect(world.network.requests).toHaveLength(0)
    expect(world.writes).toHaveLength(0)
    expect(world.reports).toHaveLength(1)
    expect(world.reports[0]).toMatchObject({ entry: 'redmine', health: { state: 'paused' } })
    expect(world.reports[0]!.health.detail).toMatch(/URL and project/)
    expect(world.store.state.values.get(`${CURSOR_PREFIX}`)).toBe(seconds(-60))
  })

  it('reports paused while the Source is switched off', async () => {
    const world = new World()
    world.config = undefined
    await world.poll()
    expect(world.reports[0]).toMatchObject({ entry: 'redmine', health: { state: 'paused' } })
    expect(world.network.requests).toHaveLength(0)
  })
})

describe('project resolution', () => {
  it('resolves the identifier once, lists with the numeric id, and reuses the cache (T-15)', async () => {
    const world = new World({ issues: [] })
    expect(world.poller.facts).toEqual({})

    await world.poll()
    expect(world.network.requests.slice(0, 3).map(request => request.url.pathname))
      .toEqual(['/projects/dsh-test.json', '/users/current.json', '/issues.json'])
    expect(world.lists[0]!.url.searchParams.get('project_id')).toBe('42')
    expect(world.poller.facts).toEqual({
      account: { zh: '以 dsh-agent 连接', en: 'Connected as dsh-agent' },
      project: { zh: 'DSH Test', en: 'DSH Test' },
    })

    world.now = START + 60_000
    await world.poll()
    expect(world.network.requests.filter(request => request.url.pathname.startsWith('/projects/'))).toHaveLength(1)
    expect(world.network.requests.filter(request => request.url.pathname === '/users/current.json')).toHaveLength(1)
    expect(world.lists).toHaveLength(2)
    expect(world.lists[1]!.url.searchParams.get('project_id')).toBe('42')
  })

  it('re-resolves when the configured project or URL changes', async () => {
    const world = new World({ issues: [] })
    await world.poll()
    expect(world.poller.facts).not.toEqual({})

    world.config = RedmineConfigSchema.parse({ baseUrl: BASE, projectId: 'other-project' })
    // Facts are bound to the configuration they were learned from, so they go blank until the next validation.
    expect(world.poller.facts).toEqual({})
    world.now = START + 60_000
    await world.poll()
    expect(world.network.requests.filter(request => request.url.pathname === '/projects/other-project.json')).toHaveLength(1)

    world.config = RedmineConfigSchema.parse({ baseUrl: 'http://other.test', projectId: 'other-project' })
    world.now = START + 120_000
    await world.poll()
    expect(world.network.requests.filter(request => request.url.pathname === '/projects/other-project.json')).toHaveLength(2)
    expect(world.network.requests.filter(request => request.url.pathname === '/users/current.json')).toHaveLength(3)
  })
})

describe('page walk', () => {
  it('stops after one list request when the oldest issue on the page is before the window (T-19a)', async () => {
    const issues = [listIssue(1, 5), ...Array.from({ length: 99 }, (_, index) => listIssue(100 + index, -10 - index))]
    const world = new World({ issues, details: [detailIssue(1)] })
    await world.poll()
    expect(world.lists).toHaveLength(1)
    expect(world.detailIds()).toEqual([1])
    expect(world.reports.at(-1)!.health.state).toBe('ready')
    expect(world.cursor()).toBe(seconds(0))
  })

  it('pages to offset=100 when the whole first page is inside the window (T-19b)', async () => {
    const issues = Array.from({ length: 150 }, (_, index) => listIssue(index + 1, 150 - index))
    const world = new World({ issues, details: issues.map(row => detailIssue(row.id)) })
    await world.poll()
    expect(world.lists.map(request => request.url.searchParams.get('offset'))).toEqual(['0', '100'])
    expect(world.detailIds()).toHaveLength(150)
    expect(world.reports.at(-1)!.health).toMatchObject({ state: 'ready' })
    expect(world.reports.at(-1)!.health.detail).toMatch(/Read 150 issues and received 0 triggers/)
  })

  it('reads bare Redmine timestamps in the configured zone (Redmine 2.3, T-16)', async () => {
    const bare = '2026-11-02 18:00:00'
    const world = new World({
      config: { timezone: 'Asia/Shanghai' },
      issues: [issue(12, { created_on: bare, updated_on: bare })],
      details: [issue(12, { created_on: bare, updated_on: bare, journals: [] })],
    })
    await world.poll()
    expect(world.reports.at(-1)!.health.state).toBe('ready')
    expect(world.triggers.map(trigger => trigger.meta.kind)).toEqual(['issue'])
    expect(world.triggers[0]!.at).toBe('2026-11-02T10:00:00.000Z')
    expect(world.cursor()).toBe(seconds(0))
  })

  it('never sends a timestamp or filter parameter on the list endpoint (T-19c)', async () => {
    const issues = Array.from({ length: 150 }, (_, index) => listIssue(index + 1, 150 - index))
    const world = new World({ issues, details: issues.map(row => detailIssue(row.id)) })
    await world.poll()
    expect(world.lists).toHaveLength(2)
    for (const request of world.lists) {
      expect(request.url.searchParams.get('updated_on')).toBeNull()
      expect([...request.url.searchParams.keys()].some(name => name.startsWith('f['))).toBe(false)
    }
  })

  it('drains a window larger than ten pages, delivering the older events too (T-19b, NFR-02)', async () => {
    const cursor = seconds(-600)
    const total = 1200
    const issues = Array.from({ length: total }, (_, index) => listIssue(index + 1, -600 - Math.floor(index / 10)))
    // A journal on every issue proves the walk reached the oldest end of the window, not only its first pages.
    const details = issues.map((row, index) => detailIssue(row.id,
      { journals: [note(1000 + index, -600 - Math.floor(index / 10))] }))
    const world = new World({ cursor, issues, details })

    await world.poll()
    // A ten-page cut would re-read this same newest block forever and lose the rest.
    expect(world.lists.map(request => request.url.searchParams.get('offset')))
      .toEqual(['0', '100', '200', '300', '400', '500', '600', '700', '800', '900', '1000', '1100'])
    expect(world.detailIds()).toHaveLength(total)
    expect(world.triggers).toHaveLength(total)
    // The walk reverses the newest-first pages, so the oldest issue of the window is processed first.
    expect(world.triggers.at(0)!.meta.issueId).toBe(total)
    expect(world.reports.at(-1)!.health).toMatchObject({ state: 'ready' })
    expect(world.reports.at(-1)!.health.detail).toMatch(new RegExp(`Read ${total} issues`))
    expect(world.cursor()).toBe(seconds(0))
  })

  it('drains a window larger than a hundred pages, in order and with its oldest events (T-19b, NFR-02)', async () => {
    const cursor = seconds(-600)
    const total = 10_050
    const issues = Array.from({ length: total }, (_, index) => listIssue(index + 1, -600 - Math.floor(index / 100)))
    // Journals on the newest and the oldest issue prove both ends of a >100-page window are delivered, oldest first.
    const details = issues.map((row, index) => detailIssue(row.id,
      { journals: index === 0 || index === total - 1 ? [note(2000 + index, -600 - Math.floor(index / 100))] : [] }))
    const world = new World({ cursor, issues, details })

    await world.poll()
    expect(world.lists).toHaveLength(Math.ceil(total / PAGE_SIZE))
    expect(world.detailIds()).toHaveLength(total)
    expect(world.detailIds()[0]).toBe(total)
    expect(world.detailIds().at(-1)).toBe(1)
    expect(world.triggers.map(trigger => trigger.meta.issueId)).toEqual([total, 1])
    expect(world.reports.at(-1)!.health.state).toBe('ready')
    expect(world.cursor()).toBe(seconds(0))
  })

  it('fails the round on an unreadable timestamp instead of skipping the issue and advancing (NFR-02)', async () => {
    const broken = issue(12, { created_on: seconds(-3600), updated_on: 'yesterday-ish' })
    const world = new World({ config: { failuresBeforeError: 1 }, issues: [broken], details: [detailIssue(12)] })
    await world.poll()
    expect(world.reports.at(-1)!.health.state).toBe('error')
    expect(world.reports.at(-1)!.health.detail).toMatch(/unreadable timestamp/)
    expect(world.detailIds()).toEqual([])
    expect(world.cursor()).toBeUndefined()
  })

  it('learns the ?key= fallback through the poller when a proxy strips the header (K-01)', async () => {
    const world = new World({ stripHeaderAuth: true, issues: [listIssue(1, 0)], details: [detailIssue(1)] })
    await world.poll()
    expect(world.reports.at(-1)!.health.state).toBe('ready')
    expect(world.cursor()).toBe(seconds(0))
    // The very first request is refused, then every later one carries the key in the query string.
    expect(world.network.requests[0]!.headers.has('X-Redmine-API-Key')).toBe(true)
    expect(world.network.requests.at(-1)!.headers.has('X-Redmine-API-Key')).toBe(false)
    expect(world.network.requests.at(-1)!.url.searchParams.get('key')).toBe('secret-key')
  })
})

describe('trigger delivery', () => {
  it('delivers exactly the journals added between two rounds, in created_on order (T-10)', async () => {
    const world = new World({
      issues: [listIssue(12, 0)],
      details: [detailIssue(12, { journals: [note(100, -3600)] })],
    })
    await world.poll()
    expect(world.triggers).toHaveLength(0)

    world.now = START + 120_000
    world.server.issues = [listIssue(12, 90)]
    world.server.details.set(12, detailIssue(12, {
      journals: [note(103, 90), note(100, -3600), note(102, 60), note(101, 30)],
    }))
    await world.poll()
    expect(world.triggers.map(trigger => trigger.meta.journalId)).toEqual([101, 102, 103])
    expect(world.triggers.map(trigger => trigger.meta.kind)).toEqual(['note', 'note', 'note'])
  })

  it('re-reads the overlap without producing a new trigger id (T-12)', async () => {
    const world = new World({
      issues: [listIssue(12, 30)],
      details: [detailIssue(12, { journals: [note(101, 30)] })],
    })
    await world.poll()
    expect(world.triggers).toHaveLength(1)

    world.now = START + 60_000
    await world.poll()
    expect(world.triggers).toHaveLength(2)
    expect(world.triggers[1]!.id).toBe(world.triggers[0]!.id)
    expect(new Set(world.triggers.map(trigger => trigger.id)).size).toBe(1)
  })

  it('keeps stable ids across a fresh poller reading the same persisted cursor (T-13)', async () => {
    const store = createStore()
    const issues = [listIssue(12, 30)]
    const details = [detailIssue(12, { journals: [note(101, 30)] })]
    const first = new World({ store, issues, details })
    await first.poll()
    expect(first.triggers).toHaveLength(1)

    const second = new World({ store, now: START + 60_000, issues, details })
    await second.poll()
    expect(second.triggers).toHaveLength(1)
    expect(second.triggers[0]!.id).toBe(first.triggers[0]!.id)
    expect(second.cursor()).toBe(seconds(60))
  })

  it('does not replay an old journal on an issue that was just updated (T-18)', async () => {
    const world = new World({
      issues: [listIssue(12, 200), listIssue(13, -30)],
      details: [detailIssue(12, { journals: [note(100, -60), note(101, 100)] })],
    })
    await world.poll()
    expect(world.triggers.map(trigger => trigger.meta.journalId)).toEqual([101])
    expect(world.triggers[0]!.meta.kind).toBe('note')
    expect(world.detailIds()).toEqual([12])
  })
})

describe('failures', () => {
  it('keeps the cursor on a failed round and delivers the missed notes once Redmine recovers (T-11)', async () => {
    const world = new World({
      issues: [listIssue(12, 0)],
      details: [detailIssue(12, { journals: [note(100, -3600)] })],
    })
    await world.poll()
    expect(world.cursor()).toBe(seconds(0))

    world.now = START + 120_000
    world.server.issues = [listIssue(12, 30)]
    world.server.details.set(12, detailIssue(12, { journals: [note(100, -3600), note(101, 30)] }))
    let failing = true
    world.server.list = () => failing ? { status: 500, text: 'Internal Server Error' } : undefined
    await world.poll()
    expect(world.poller.failures).toBe(1)
    expect(world.cursor()).toBe(seconds(0))
    expect(world.triggers).toHaveLength(0)
    expect(world.reports).toHaveLength(1)

    failing = false
    world.now = START + 180_000
    await world.poll()
    expect(world.poller.failures).toBe(0)
    expect(world.triggers.map(trigger => trigger.meta.journalId)).toEqual([101])
    expect(world.cursor()).toBe(seconds(180))
  })

  it('reports error only after failuresBeforeError consecutive failures', async () => {
    const world = new World({ config: { failuresBeforeError: 3 }, issues: [] })
    world.server.list = () => ({ status: 503, text: 'maintenance' })

    await world.poll()
    await world.poll()
    expect(world.poller.failures).toBe(2)
    expect(world.reports).toHaveLength(0)

    await world.poll()
    expect(world.poller.failures).toBe(3)
    expect(world.reports).toHaveLength(1)
    expect(world.reports[0]!.health).toMatchObject({ state: 'error' })
    expect(world.reports[0]!.health.detail).toMatch(/503/)

    world.server.list = undefined
    await world.poll()
    expect(world.poller.failures).toBe(0)
    expect(world.reports.at(-1)!.health.state).toBe('ready')
  })

  it('skips a 403/404 detail, keeps processing the rest, and still advances (T-17)', async () => {
    const world = new World({
      issues: [listIssue(13, 20), listIssue(14, 10), listIssue(12, 5)],
      details: [detailIssue(12, { journals: [note(101, 2)] })],
    })
    world.server.detail = id => id === 13 ? { status: 404, text: 'Not Found' }
      : id === 14 ? { status: 403, text: 'Forbidden' } : undefined
    await world.poll()
    expect(world.triggers.map(trigger => trigger.meta.journalId)).toEqual([101])
    expect(world.describes.map(entry => entry.key)).toEqual(['redmine:12'])
    expect(world.describes[0]!.description).toMatchObject({
      label: '#12 Issue 12',
      url: 'http://redmine.test/issues/12',
      facts: { status: { label: 'Status', value: 'In Progress' }, tracker: { label: 'Tracker', value: 'Bug' } },
    })
    expect(world.cursor()).toBe(seconds(0))
    expect(world.reports.at(-1)!.health.state).toBe('ready')
    expect(world.reports.at(-1)!.health.detail).toMatch(/#13 \(404\)/)
    expect(world.reports.at(-1)!.health.detail).toMatch(/#14 \(403\)/)
  })

  it('reports an expired API key as a configuration error before listing anything (K-03b)', async () => {
    const world = new World({ issues: [] })
    world.server.user = () => ({ status: 401, text: 'Unauthorized' })
    await world.poll()
    expect(world.reports.at(-1)).toMatchObject({ entry: 'redmine', health: { state: 'error' } })
    expect(world.reports.at(-1)!.health.detail).toMatch(/API key was rejected \(401\)/)
    expect(world.lists).toHaveLength(0)
    expect(world.triggers).toHaveLength(0)
  })

  it('reports a bad time zone as a configuration error instead of retrying forever (FR-02)', async () => {
    const world = new World({ config: { timezone: 'Mars/Olympus' }, issues: [listIssue(1, 0)], details: [detailIssue(1)] })
    await world.poll()
    expect(world.reports.at(-1)).toMatchObject({ entry: 'redmine', health: { state: 'error' } })
    expect(world.reports.at(-1)!.health.detail).toMatch(/Invalid time zone/)
    expect(world.cursor()).toBeUndefined()
  })

  it('reports a configuration error immediately when the project is not visible (K-03b)', async () => {
    const world = new World({ issues: [] })
    world.server.project = () => ({ status: 404, text: 'Not Found' })
    await world.poll()
    expect(world.reports).toHaveLength(1)
    expect(world.reports[0]).toMatchObject({ entry: 'redmine', health: { state: 'error' } })
    expect(world.reports[0]!.health.detail).toMatch(/project was not found \(404\)/)
    expect(world.lists).toHaveLength(0)
    expect(world.triggers).toHaveLength(0)
    expect(world.poller.failures).toBe(1)
  })

  it('reports a configuration error immediately when the API key variable is missing (K-03b)', async () => {
    const world = new World({ config: { apiKeyEnv: 'REDMINE_KEY_NOT_SET' } })
    await world.poll()
    expect(world.reports).toHaveLength(1)
    expect(world.reports[0]!.health).toMatchObject({ state: 'error' })
    expect(world.reports[0]!.health.detail).toMatch(/REDMINE_KEY_NOT_SET/)
    expect(world.network.requests).toHaveLength(0)
    expect(world.triggers).toHaveLength(0)
  })
})

describe('health', () => {
  it('stays ready and hints at the view-issues permission when the project returns no issues (K-03a)', async () => {
    const world = new World({ issues: [] })
    await world.poll()
    const health = world.reports.at(-1)!.health
    expect(health.state).toBe('ready')
    expect(health.detail).toMatch(/View issues/i)
    expect(health.detail).toMatch(/permission/i)
    expect(health.at).toBe(seconds(0))
    expect(world.poller.failures).toBe(0)
  })

  it('reports the numbers of the round and advances the cursor on success', async () => {
    const world = new World({
      issues: [listIssue(12, 10)],
      details: [detailIssue(12, { created: 0, journals: [note(101, 5)] })],
    })
    await world.poll()
    expect(world.reports.at(-1)!.health.detail).toBe('Read 1 issue and received 2 triggers.')
    // The issue's own trigger goes out before its journals.
    expect(world.triggers.map(trigger => trigger.meta.kind)).toEqual(['issue', 'note'])
    expect(world.cursor()).toBe(seconds(0))
  })
})

describe('abort', () => {
  it('does nothing when the signal is already aborted', async () => {
    const world = new World({ issues: [listIssue(12, 10)], details: [detailIssue(12)] })
    const controller = new AbortController()
    controller.abort()
    await world.poll(controller.signal)
    expect(world.network.requests).toHaveLength(0)
    expect(world.writes).toHaveLength(0)
    expect(world.reports).toHaveLength(0)
  })

  it('stops after a mid-round abort without advancing the cursor', async () => {
    const controller = new AbortController()
    const world = new World({
      issues: [listIssue(13, 20), listIssue(12, 10)],
      details: [
        detailIssue(12, { journals: [note(101, 2)] }),
        detailIssue(13, { journals: [note(102, 15)] }),
      ],
      receive: () => controller.abort(),
    })
    await world.poll(controller.signal)
    expect(world.triggers).toHaveLength(1)
    expect(world.poller.failures).toBe(0)
    expect(world.writes).toHaveLength(0)
    expect(world.reports).toHaveLength(0)
  })
})
