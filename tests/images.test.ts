import { describe, expect, it } from 'vitest'
import { RedmineConfigSchema, type RedmineConfig } from '../src/config.ts'
import type { AttachmentService, ImageMediaType, LlmService, Trigger } from '../src/contract.ts'
import { RedmineClient, connectionOf } from '../src/redmine/client.ts'
import { readImage } from '../src/redmine/images.ts'
import { fakeFetch, type FakeReply, type FakeRequest } from './helpers/fetch.ts'
import { attachment, issue } from './helpers/fixtures.ts'

const env = { REDMINE_API_KEY: 'secret-key' }
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const config = (overrides: Partial<RedmineConfig> = {}): RedmineConfig =>
  RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test', ...overrides })

interface SavedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  name: string
}

/** A plain object shaped like `ImageAgent`; no real DSH service is involved. */
function agentOf(attachments: AttachmentService, llm: LlmService, route?: { provider: string; model: string }) {
  const provider = route?.provider ?? 'test'
  const model = route?.model ?? 'vision-model'
  return {
    ctx: { get: (name: string) => name === 'attachments' ? attachments : name === 'llm' ? llm : undefined },
    session: { requestHeader: (): { config?: { provider?: string; model?: string } } | undefined => ({ config: { provider, model } }) },
    options: { provider, model },
  }
}

/** Builds the reader with a fake attachment service, a fake model, and a scripted Redmine. */
function harness(reply: (request: FakeRequest) => FakeReply | undefined,
  options: { modalities?: readonly string[]; maxImageBytes?: number; maxMessageImageBytes?: number } = {}) {
  const network = fakeFetch(reply)
  const settings = config()
  const saved: SavedImage[] = []
  const attachments: AttachmentService = {
    imageLimits: { maxImageBytes: options.maxImageBytes ?? 1024, maxMessageImageBytes: options.maxMessageImageBytes ?? 800 },
    saveImage: async input => {
      saved.push(input)
      return { id: `image-${saved.length}`, mediaType: input.mediaType }
    },
  }
  const llm: LlmService = {
    resolveModelInfo: async () => ({ inputModalities: options.modalities ?? ['text', 'image'] }),
  }
  const optionsForReader = {
    config: () => settings,
    clients: (value: RedmineConfig) => new RedmineClient({ connection: connectionOf(value, env), fetch: network.fetch }),
  }
  return { network, settings, saved, attachments, llm, agent: agentOf(attachments, llm), reader: optionsForReader }
}

function triggerOf(): Trigger {
  return {
    id: 'trigger-1',
    source: 'redmine',
    threads: [{ source: 'redmine', id: '12' }],
    actor: { source: 'redmine', id: '7' },
    human: true,
    at: '2026-11-02T02:00:00.000Z',
    text: '@dsh look at this',
    meta: { kind: 'note', issueId: 12, journalId: 9, messageId: 'journal:9' },
  }
}

const signal = (): AbortSignal => new AbortController().signal

const metadataReply = (record: Record<string, unknown>): FakeReply => ({ body: { attachment: record } })
const downloadReply = (bytes = PNG, contentType = 'image/png'): FakeReply =>
  ({ bytes, headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) } })

describe('readImage (att: keys)', () => {
  it('downloads a PNG within the limit and saves it through the attachment service (T-32)', async () => {
    const image = attachment({ id: 456, filename: 'foo.png', content_type: 'image/png' })
    const { reader, agent, network, saved } = harness(request => {
      if (request.url.pathname === '/attachments/456.json') return metadataReply(image)
      if (request.url.pathname === '/attachments/download/456/foo.png') return downloadReply()
      return undefined
    })
    const result = await readImage(reader, agent, triggerOf(), { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' },
      'att:456', '/state', signal())
    expect(result).toEqual({ source_message_id: 'journal:9', image_key: 'att:456', image: { id: 'image-1', mediaType: 'image/png' } })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.mediaType).toBe('image/png')
    expect(saved[0]!.name).toBe('foo.png')
    expect([...saved[0]!.data]).toEqual([...PNG])
    expect(network.requests[1]!.url.pathname).toBe('/attachments/download/456/foo.png')
    expect(network.requests[1]!.headers.get('X-Redmine-API-Key')).toBe('secret-key')
  })

  it('infers the media type from the file name when content_type is not a supported image type', async () => {
    const image = attachment({ id: 457, filename: 'shot.jpeg', content_type: 'application/octet-stream' })
    const { reader, agent, saved } = harness(request => {
      if (request.url.pathname === '/attachments/457.json') return metadataReply(image)
      if (request.url.pathname.startsWith('/attachments/download/')) return downloadReply(PNG, 'application/octet-stream')
      return undefined
    })
    await readImage(reader, agent, triggerOf(), { id: 'journal:9', text: '<img src="/attachments/download/457/shot.jpeg">' },
      'att:457', '/state', signal())
    expect(saved[0]!.mediaType).toBe('image/jpeg')
  })

  it('refuses an attachment over the deployment byte limit instead of ignoring it (T-33)', async () => {
    const image = attachment({ id: 456, filename: 'big.png' })
    const big = new Uint8Array(64)
    const { reader, agent, saved } = harness(request => {
      if (request.url.pathname === '/attachments/456.json') return metadataReply(image)
      return downloadReply(big)
    }, { maxImageBytes: 100, maxMessageImageBytes: 50 })
    await expect(readImage(reader, agent, triggerOf(), { id: 'journal:9', text: '<img src="/attachments/download/456/big.png">' },
      'att:456', '/state', signal())).rejects.toThrow(/deployment limit is 50/)
    expect(saved).toHaveLength(0)
  })

  it('rejects an attachment that is not a supported image type', async () => {
    const document = attachment({ id: 458, filename: 'notes.pdf', content_type: 'application/pdf' })
    const { reader, agent, saved } = harness(request => {
      if (request.url.pathname === '/attachments/458.json') return metadataReply(document)
      if (request.url.pathname.startsWith('/attachments/download/')) return downloadReply(PNG, 'application/pdf')
      return undefined
    })
    // The URL carries no file name, so the key is offered; the type is decided from the attachment metadata instead.
    await expect(readImage(reader, agent, triggerOf(), { id: 'journal:9', text: '<img src="/attachments/download/458">' },
      'att:458', '/state', signal())).rejects.toThrow('The attachment is not a supported PNG/JPEG/WebP/GIF image')
    expect(saved).toHaveLength(0)
  })

  it('reports a 403 while reading the attachment or downloading it as a readable image failure', async () => {
    const forbiddenRead = harness(() => ({ status: 403, text: 'Forbidden' }))
    await expect(readImage(forbiddenRead.reader, forbiddenRead.agent, triggerOf(),
      { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' }, 'att:456', '/state', signal()))
      .rejects.toThrow(/The image could not be read: .*403/)
    const readable = attachment({ id: 456, filename: 'foo.png' })
    const forbiddenDownload = harness(request => request.url.pathname === '/attachments/456.json'
      ? metadataReply(readable) : { status: 403, text: 'Forbidden' })
    await expect(readImage(forbiddenDownload.reader, forbiddenDownload.agent, triggerOf(),
      { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' }, 'att:456', '/state', signal()))
      .rejects.toThrow(/The image could not be read: .*403/)
    expect(forbiddenDownload.saved).toHaveLength(0)
  })
})

describe('readImage guards', () => {
  it('rejects a key that does not occur in the source message (T-35)', async () => {
    const { reader, agent, network } = harness(() => undefined)
    await expect(readImage(reader, agent, triggerOf(), { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' },
      'att:999', '/state', signal())).rejects.toThrow('Choose an image key from this source message')
    expect(network.requests).toHaveLength(0)
  })

  it('rejects a model without image input, naming the limitation in both languages (T-34)', async () => {
    const { reader, agent, network } = harness(() => undefined, { modalities: ['text'] })
    const failure = await readImage(reader, agent, triggerOf(),
      { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' }, 'att:456', '/state', signal())
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('does not support image input')
    expect((failure as Error).message).toContain('模型不支持图片输入')
    expect(network.requests).toHaveLength(0)
  })

  it('fails before downloading when the Source is not configured', async () => {
    const { agent, network } = harness(() => undefined)
    const reader = { config: () => undefined, clients: () => { throw new Error('unexpected client build') } }
    await expect(readImage(reader, agent, triggerOf(),
      { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' }, 'att:456', '/state', signal()))
      .rejects.toThrow('The Redmine Source is not configured')
    expect(network.requests).toHaveLength(0)
  })

  it('does not save an image when the signal was already aborted', async () => {
    const image = attachment({ id: 456, filename: 'foo.png' })
    const { reader, agent, saved } = harness(request => {
      if (request.url.pathname === '/attachments/456.json') return metadataReply(image)
      return downloadReply()
    })
    const controller = new AbortController()
    controller.abort()
    await expect(readImage(reader, agent, triggerOf(),
      { id: 'journal:9', text: '<img src="/attachments/download/456/foo.png">' }, 'att:456', '/state', controller.signal))
      .rejects.toThrow(/abort/i)
    expect(saved).toHaveLength(0)
  })
})

describe('readImage (file: keys)', () => {
  const sameName = [
    attachment({ id: 40, filename: 'foo.png', content_url: '/attachments/download/40/foo.png' }),
    attachment({ id: 41, filename: 'bar.png', content_url: '/attachments/download/41/bar.png' }),
    attachment({ id: 42, filename: 'foo.png', content_url: '/attachments/download/42/foo.png' }),
  ]

  it('resolves a wiki image name against the issue attachments, preferring the newest id (T-31)', async () => {
    const { reader, agent, network, saved } = harness(request => {
      if (request.url.pathname === '/issues/12.json') return { body: { issue: issue(12, { attachments: sameName }) } }
      if (request.url.pathname === '/attachments/download/42/foo.png') return downloadReply()
      return undefined
    })
    const result = await readImage(reader, agent, triggerOf(), { id: 'journal:9', text: 'see !foo.png!' },
      'file:foo.png', '/state', signal())
    expect(result).toMatchObject({ source_message_id: 'journal:9', image_key: 'file:foo.png' })
    expect(saved[0]!.name).toBe('foo.png')
    expect(network.requests[0]!.url.searchParams.get('include')).toBe('attachments')
    expect(network.requests.some(request => request.url.pathname === '/attachments/download/42/foo.png')).toBe(true)
    expect(network.requests.some(request => request.url.pathname.includes('/40/'))).toBe(false)
  })

  it('falls back to the attachment endpoint when the issue list omits content_url', async () => {
    const bare = attachment({ id: 43, filename: 'foo.png', content_url: null })
    const detail = attachment({ id: 43, filename: 'foo.png', content_url: '/attachments/download/43/foo.png' })
    const { reader, agent, network } = harness(request => {
      if (request.url.pathname === '/issues/12.json') return { body: { issue: issue(12, { attachments: [bare] }) } }
      if (request.url.pathname === '/attachments/43.json') return metadataReply(detail)
      if (request.url.pathname === '/attachments/download/43/foo.png') return downloadReply()
      return undefined
    })
    await readImage(reader, agent, triggerOf(), { id: 'journal:9', text: 'attachment:foo.png' },
      'file:foo.png', '/state', signal())
    expect(network.requests.some(request => request.url.pathname === '/attachments/43.json')).toBe(true)
    expect(network.requests.some(request => request.url.pathname === '/attachments/download/43/foo.png')).toBe(true)
  })

  it('reports a readable failure when the issue has no attachment by that name', async () => {
    const { reader, agent } = harness(() => ({ body: { issue: issue(12, { attachments: sameName }) } }))
    await expect(readImage(reader, agent, triggerOf(), { id: 'journal:9', text: 'see !missing.png!' },
      'file:missing.png', '/state', signal())).rejects.toThrow('The issue has no attachment named missing.png')
  })
})
