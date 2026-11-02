import { describe, expect, it } from 'vitest'
import { RedmineClient, RedmineClientFactory, RedmineConfigError, RedmineError, connectionOf, normalizeBaseUrl } from '../src/redmine/client.ts'
import { RedmineConfigSchema, type RedmineConfig } from '../src/config.ts'
import { fakeFetch, issueJson, type FakeReply } from './helpers/fetch.ts'

const config = (overrides: Partial<RedmineConfig> = {}): RedmineConfig =>
  RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test', ...overrides })
const env = { REDMINE_API_KEY: 'secret-key' }

function client(reply: (request: { url: URL; method: string; headers: Headers; body?: string }) => FakeReply | undefined,
  overrides: Partial<RedmineConfig> = {}) {
  const network = fakeFetch(reply)
  return { network, client: new RedmineClient({ connection: connectionOf(config(overrides), env), fetch: network.fetch }) }
}

describe('connectionOf', () => {
  it('requires the URL, the project, and the key in the named environment variable', () => {
    expect(() => connectionOf(config({ baseUrl: '' }), env)).toThrow(RedmineConfigError)
    expect(() => connectionOf(config({ projectId: '' }), env)).toThrow(/project is not configured/)
    expect(() => connectionOf(config(), {})).toThrow(/REDMINE_API_KEY/)
    expect(connectionOf(config(), env)).toEqual({ baseUrl: 'http://redmine.test', apiKey: 'secret-key', auth: 'header' })
  })

  it('normalizes the root URL and rejects non-HTTP schemes', () => {
    expect(normalizeBaseUrl('http://redmine.test/')).toBe('http://redmine.test')
    expect(normalizeBaseUrl(' https://redmine.test/redmine// ')).toBe('https://redmine.test/redmine')
    expect(() => normalizeBaseUrl('ftp://redmine.test')).toThrow(/http/)
    expect(() => normalizeBaseUrl('not a url')).toThrow(/valid URL/)
  })
})

describe('authentication', () => {
  it('sends the API key as a header', async () => {
    const { client: api, network } = client(() => ({ body: { user: { id: 9, login: 'dsh-agent' } } }))
    await api.currentUser()
    expect(network.requests[0]!.headers.get('X-Redmine-API-Key')).toBe('secret-key')
    expect(network.requests[0]!.url.searchParams.get('key')).toBeNull()
  })

  it('falls back to ?key= when a proxy strips the header, and remembers the mode (K-01)', async () => {
    const { client: api, network } = client(request =>
      request.headers.get('X-Redmine-API-Key') ? { status: 401, text: '' } : { body: { user: { id: 9, login: 'dsh-agent' } } })
    const user = await api.currentUser()
    expect(user.login).toBe('dsh-agent')
    expect(network.requests).toHaveLength(2)
    expect(network.requests[0]!.url.searchParams.get('key')).toBeNull()
    expect(network.requests[1]!.url.searchParams.get('key')).toBe('secret-key')
    expect(api.usesQueryAuth).toBe(true)
    await api.currentUser()
    expect(network.requests).toHaveLength(3)
    expect(network.requests[2]!.url.searchParams.get('key')).toBe('secret-key')
  })
})

describe('reads', () => {
  it('lists recently updated issues without a server-side time filter (T-19c)', async () => {
    const { client: api, network } = client(() => ({ body: { issues: [issueJson()], total_count: 1, offset: 0, limit: 100 } }))
    const page = await api.issues({ projectId: 3, offset: 100 })
    expect(page.issues[0]!.id).toBe(12)
    const url = network.requests[0]!.url
    expect(url.pathname).toBe('/issues.json')
    expect(url.searchParams.get('project_id')).toBe('3')
    expect(url.searchParams.get('status_id')).toBe('*')
    expect(url.searchParams.get('sort')).toBe('updated_on:desc,id:desc')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('offset')).toBe('100')
    expect(url.searchParams.get('updated_on')).toBeNull()
    expect([...url.searchParams.keys()].some(name => name.startsWith('f['))).toBe(false)
  })

  it('reads one issue with journals and attachments, and encodes identifiers (B3)', async () => {
    const { client: api, network } = client(request => request.url.pathname.startsWith('/projects/')
      ? { body: { project: { id: 12, identifier: 'my project', name: 'My Project' } } }
      : { body: { issue: issueJson({ journals: [{ id: 1, user: { id: 7, name: 'Alice' }, notes: 'hi', created_on: '2026-11-02T10:00:00+08:00' }] }) } })
    const detail = await api.issue(12, ['journals', 'attachments'])
    expect(detail.journals?.[0]?.notes).toBe('hi')
    expect(network.requests[0]!.url.searchParams.get('include')).toBe('journals,attachments')
    const project = await api.project('my project')
    expect(project.id).toBe(12)
    expect(network.requests[1]!.url.pathname).toBe('/projects/my%20project.json')
  })

  it('maps non-2xx responses to RedmineError with the status', async () => {
    const { client: api } = client(() => ({ status: 403, text: 'Forbidden' }))
    await expect(api.issue(12)).rejects.toMatchObject({ name: 'RedmineError', status: 403 })
    await expect(api.issue(12)).rejects.toBeInstanceOf(RedmineError)
  })
})

describe('write-back', () => {
  it('puts only issue.notes and never touches other fields (T-24)', async () => {
    const { client: api, network } = client(() => ({ status: 204 }))
    await api.addNote(12, 'done')
    const request = network.requests[0]!
    expect(request.method).toBe('PUT')
    expect(request.url.pathname).toBe('/issues/12.json')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(request.body!)).toEqual({ issue: { notes: 'done' } })
  })
})

describe('attachments', () => {
  it('rewrites content_url onto the configured origin and downloads the bytes (K-06)', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const { client: api, network } = client(request => request.url.pathname.startsWith('/attachments/download/')
      ? { bytes, headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) } }
      : { body: { attachment: { id: 456, filename: 'shot.png', content_type: 'image/png', content_url: 'http://internal-host:3000/attachments/download/456/shot.png' } } })
    const meta = await api.attachment(456)
    const image = await api.download(meta.content_url!, { maxBytes: 1_000 })
    expect(image.contentType).toBe('image/png')
    expect(image.data.byteLength).toBe(4)
    expect(network.requests[1]!.url.href).toBe('http://redmine.test/attachments/download/456/shot.png')
    expect(network.requests[1]!.headers.get('X-Redmine-API-Key')).toBe('secret-key')
  })

  it('still enforces the limit when a lying Content-Length is below the byte limit', async () => {
    const bytes = new Uint8Array(64)
    const { client: api } = client(() => ({ bytes, headers: { 'content-length': '10' } }))
    await expect(api.download('/attachments/download/1/big.png', { maxBytes: 40 })).rejects.toThrow(/limit/)
  })

  it('stops a chunked attachment at the byte limit instead of buffering it all', async () => {
    const chunks = [new Uint8Array(32), new Uint8Array(32)]
    const stream = (): ReadableStream<Uint8Array> => new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() },
    })
    const over = client(() => ({ stream: stream() }))
    await expect(over.client.download('/attachments/download/1/big.png', { maxBytes: 40 })).rejects.toThrow(/limit/)
    const under = client(() => ({ stream: stream() }))
    const image = await under.client.download('/attachments/download/1/ok.png', { maxBytes: 64 })
    expect(image.data.byteLength).toBe(64)
  })

  it('refuses an attachment over the byte limit', async () => {
    const bytes = new Uint8Array(64)
    const { client: api } = client(() => ({ bytes, headers: { 'content-length': '64' } }))
    await expect(api.download('/attachments/download/1/big.png', { maxBytes: 10 })).rejects.toThrow(/limit is 10/)
  })
})

describe('RedmineClientFactory', () => {
  it('reuses one client per connection and keeps the learned auth mode', async () => {
    const network = fakeFetch(request => request.headers.get('X-Redmine-API-Key') ? { status: 401 } : { body: { user: { id: 9, login: 'dsh-agent' } } })
    const factory = new RedmineClientFactory({ env, fetch: network.fetch })
    const first = factory.get(config())
    expect(factory.get(config())).toBe(first)
    await first.currentUser()
    expect(first.usesQueryAuth).toBe(true)
    const other = factory.get(config({ baseUrl: 'http://other.test' }))
    expect(other).not.toBe(first)
    expect(other.usesQueryAuth).toBe(false)
  })
})
