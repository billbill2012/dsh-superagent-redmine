import { describe, expect, it } from 'vitest'
import { RedmineConfigSchema, type RedmineConfig } from '../src/config.ts'
import type { OutboundMessage } from '../src/contract.ts'
import { createChannel } from '../src/redmine/channel.ts'
import { RedmineClient, RedmineError, connectionOf } from '../src/redmine/client.ts'
import { fakeFetch, issueJson, type FakeReply } from './helpers/fetch.ts'

const env = { REDMINE_API_KEY: 'secret-key' }

/** The marker the channel must append; asserted literally so a format regression cannot hide behind a helper. */
const marker = (messageId: string): string => `<!-- dsh-redmine:${messageId} -->`

const config = (overrides: Partial<RedmineConfig> = {}): RedmineConfig =>
  RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test', ...overrides })

/** Builds the channel over a real client so the PUT body and URL are the ones production would send. */
function channel(reply: (request: { url: URL; method: string; body?: string }) => FakeReply | undefined,
  configValue: RedmineConfig = config()) {
  const network = fakeFetch(reply)
  return {
    network,
    channel: createChannel({
      config: () => configValue,
      clients: value => new RedmineClient({ connection: connectionOf(value, env), fetch: network.fetch }),
    }),
  }
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: 'reply-1',
    channel: { source: 'redmine', thread: 'redmine:12', address: { issueId: '12', url: 'http://redmine.test/issues/12' } },
    text: 'Fixed the header.',
    kind: 'reply',
    ...overrides,
  }
}

/** The issue read behind every write: the existing client treats the single-issue response as the record itself. */
const readableIssue = (journals: Record<string, unknown>[] = []) => ({ body: { issue: issueJson({ journals }) } })

describe('channel.allowed', () => {
  it('refuses the address while writeBack=off, so no request is ever attempted (T-22)', () => {
    const { channel: delivery, network } = channel(() => undefined, config({ writeBack: 'off' }))
    expect(delivery.allowed?.({ issueId: '12' }, config({ writeBack: 'off' }))).toBe(false)
    expect(delivery.allowed?.({ issueId: '12' }, config())).toBe(true)
    expect(network.requests).toHaveLength(0)
  })

  it('drops a delivery queued before writeBack was turned off (defensive)', async () => {
    const { channel: delivery, network } = channel(() => undefined, config({ writeBack: 'off' }))
    await expect(delivery.send(undefined, message())).resolves.toBe('gone')
    expect(network.requests).toHaveLength(0)
  })
})

describe('channel.send', () => {
  it('writes one note containing the hidden marker (T-20)', async () => {
    const { channel: delivery, network } = channel(request => request.method === 'PUT' ? { status: 204 } : readableIssue())
    await expect(delivery.send(undefined, message())).resolves.toBe('sent')
    expect(network.requests.map(request => request.method)).toEqual(['GET', 'PUT'])
    expect(network.requests[0]!.url.pathname).toBe('/issues/12.json')
    expect(network.requests[0]!.url.searchParams.get('include')).toBe('journals')
    const body = JSON.parse(network.requests[1]!.body!)
    expect(body.issue.notes).toContain(marker('reply-1'))
    expect(body.issue.notes).toContain('Fixed the header.')
  })

  it('sends only issue.notes, never status, assignee, or custom fields (T-24)', async () => {
    const { channel: delivery, network } = channel(request => request.method === 'PUT' ? { status: 204 } : readableIssue())
    await delivery.send(undefined, message())
    expect(JSON.parse(network.requests[1]!.body!)).toEqual({ issue: { notes: `Fixed the header.\n\n${marker('reply-1')}` } })
  })

  it('recognizes its own marker and does not write twice (T-21)', async () => {
    const journals = [{ id: 1, user: { id: 9, name: 'dsh-agent' }, notes: `Already handled.\n\n${marker('reply-1')}`,
      created_on: '2026-11-02T10:00:00+08:00' }]
    const { channel: delivery, network } = channel(() => readableIssue(journals))
    await expect(delivery.send(undefined, message())).resolves.toBe('sent')
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0]!.method).toBe('GET')
  })

  it('treats 403 and 404 as gone instead of retrying forever (T-23)', async () => {
    const forbidden = channel(() => ({ status: 403, text: 'Forbidden' }))
    await expect(forbidden.channel.send(undefined, message())).resolves.toBe('gone')
    const missing = channel(() => ({ status: 404, text: 'Not found' }))
    await expect(missing.channel.send(undefined, message())).resolves.toBe('gone')
    const removedBeforeReply = channel(request => request.method === 'PUT'
      ? { status: 404, text: 'Not found' } : readableIssue())
    await expect(removedBeforeReply.channel.send(undefined, message())).resolves.toBe('gone')
  })

  it('lets other failures propagate so the Outbox can retry or report them (T-25)', async () => {
    const { channel: delivery } = channel(request => request.method === 'PUT'
      ? { status: 422, text: 'Notes is too long' } : readableIssue())
    await expect(delivery.send(undefined, message())).rejects.toMatchObject({ name: 'RedmineError', status: 422 })
    await expect(delivery.send(undefined, message())).rejects.toBeInstanceOf(RedmineError)
    const unavailable = channel(() => ({ status: 503, text: 'Maintenance' }))
    await expect(unavailable.channel.send(undefined, message())).rejects.toMatchObject({ status: 503 })
  })

  it('throws before any request when the Source is not configured (B1)', async () => {
    const network = fakeFetch(() => undefined)
    const delivery = createChannel({ config: () => undefined, clients: () => { throw new Error('unexpected client build') } })
    await expect(delivery.send(undefined, message())).rejects.toThrow('The Redmine Source is not configured')
    expect(network.requests).toHaveLength(0)
  })

  it('rejects an address that does not carry a positive issue id', async () => {
    const { channel: delivery, network } = channel(() => readableIssue())
    await expect(delivery.send(undefined, message({
      channel: { source: 'redmine', thread: 'redmine:12', address: { issueId: 'not-a-number' } },
    }))).rejects.toThrow(/positive issue id/)
    await expect(delivery.send(undefined, message({
      channel: { source: 'redmine', thread: 'redmine:12', address: {} },
    }))).rejects.toThrow(/positive issue id/)
    expect(network.requests).toHaveLength(0)
  })
})

describe('channel.link', () => {
  it('returns the address URL, or an empty one when the address has none (B1)', () => {
    const { channel: delivery } = channel(() => undefined)
    expect(delivery.link({ url: 'http://redmine.test/issues/12' }, {})).toEqual({
      url: 'http://redmine.test/issues/12',
      label: { zh: '在 Redmine 查看', en: 'Open in Redmine' },
    })
    expect(delivery.link({}, {}).url).toBe('')
  })
})
