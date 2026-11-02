import { describe, expect, it } from 'vitest'
import { RedmineConfigSchema, type RedmineConfig } from '../src/config.ts'
import type { Trigger } from '../src/contract.ts'
import { RedmineClient, connectionOf } from '../src/redmine/client.ts'
import { createThreadContext } from '../src/redmine/read.ts'
import { imageKeys } from '../src/redmine/trigger.ts'
import type { RedmineIssue } from '../src/redmine/types.ts'
import { fakeFetch } from './helpers/fetch.ts'
import { issue, journal } from './helpers/fixtures.ts'

const env = { REDMINE_API_KEY: 'secret-key' }

const config = (overrides: Partial<RedmineConfig> = {}): RedmineConfig =>
  RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test', timezone: 'Asia/Shanghai', ...overrides })

/** Builds the reader over a real client; the existing client treats the single-issue response as the record itself. */
function contextOf(detail: RedmineIssue, overrides: Partial<RedmineConfig> = {}) {
  const network = fakeFetch(() => ({ body: { issue: detail } }))
  const settings = config(overrides)
  const context = createThreadContext({
    config: () => settings,
    clients: value => new RedmineClient({ connection: connectionOf(value, env), fetch: network.fetch }),
  })
  return { network, context, settings }
}

function triggerOf(issueId: number, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    source: 'redmine',
    threads: [{ source: 'redmine', id: String(issueId) }],
    actor: { source: 'redmine', id: '7' },
    human: true,
    at: '2026-11-02T02:00:00.000Z',
    text: '@dsh fix this',
    meta: { kind: 'issue', issueId, messageId: `issue:${issueId}` },
    ...overrides,
  }
}

describe('threadContext.messageId', () => {
  it('returns the recorded message id, falling back to the issue root for an older Trigger (B5)', () => {
    const { context } = contextOf(issue(12))
    expect(context.messageId(triggerOf(12, { meta: { issueId: 12, messageId: 'journal:4567' } }))).toBe('journal:4567')
    expect(context.messageId(triggerOf(12))).toBe('issue:12')
    // A Trigger stored before `meta.messageId` existed, and one carrying no `meta.issueId` either.
    expect(context.messageId(triggerOf(12, { meta: {} }))).toBe('issue:12')
    expect(context.messageId(triggerOf(12, { meta: {}, threads: [{ source: 'redmine', id: '31' }] }))).toBe('issue:31')
  })
})

describe('read(thread)', () => {
  it('pages 50 messages at a time with issue:<id> / journal:<id> ids and a follow-up cursor (T-36)', async () => {
    const many = Array.from({ length: 55 }, (_, index) => journal(5001 + index, {
      notes: `note ${index + 1}`,
      created_on: new Date(Date.parse('2026-11-02T10:00:00+08:00') + index * 60_000).toISOString(),
    }))
    const { context, network, settings } = contextOf(issue(12, { journals: many }))
    const first = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(first.messages).toHaveLength(50)
    expect(first.messages[0]!.id).toBe('issue:12')
    expect(first.messages[1]!.id).toBe('journal:5001')
    expect(first.messages.at(-1)!.id).toBe('journal:5049')
    expect(first.next).toBe('50')
    const second = await context.read(undefined, triggerOf(12), 'thread', first.next, settings)
    expect(second.messages.map(message => message.id)).toEqual([
      'journal:5050', 'journal:5051', 'journal:5052', 'journal:5053', 'journal:5054', 'journal:5055',
    ])
    expect(second.next).toBeUndefined()
    expect(network.requests[0]!.url.pathname).toBe('/issues/12.json')
    expect(network.requests[0]!.url.searchParams.get('include')).toBe('journals,attachments')
  })

  it('returns the issue root alone for an issue without journals', async () => {
    const { context, settings } = contextOf(issue(12))
    const page = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(page.messages.map(message => message.id)).toEqual(['issue:12'])
    expect(page.next).toBeUndefined()
  })

  it('orders journals by created_on then id, and normalizes timestamps to UTC (T-16)', async () => {
    const { context, settings } = contextOf(issue(12, {
      created_on: '2026-11-02T09:00:00',
      journals: [
        journal(9, { notes: 'second', created_on: '2026-11-02T10:00:00+08:00' }),
        journal(8, { notes: 'first', created_on: '2026-11-02T10:00:00+08:00' }),
        journal(7, { notes: 'oldest', created_on: '2026-11-02 09:30:00 +0800' }),
      ],
    }))
    const page = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(page.messages.map(message => message.id)).toEqual(['issue:12', 'journal:7', 'journal:8', 'journal:9'])
    expect(page.messages[0]!.at).toBe('2026-11-02T01:00:00.000Z')
    expect(page.messages[1]!.at).toBe('2026-11-02T01:30:00.000Z')
  })

  it('never exposes a private note to the model, in any part (B14)', async () => {
    const { context, settings } = contextOf(issue(12, {
      journals: [
        journal(1001, { notes: 'public one', created_on: '2026-11-02T09:30:00+08:00' }),
        journal(1002, { notes: 'internal: do not tell the customer', private_notes: true, created_on: '2026-11-02T10:00:00+08:00' }),
        journal(1003, { notes: 'public two', created_on: '2026-11-02T10:30:00+08:00' }),
      ],
    }))
    const thread = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(thread.messages.map(message => message.id)).toEqual(['issue:12', 'journal:1001', 'journal:1003'])

    // A private note between two public ones must not become the parent of the later message either.
    const parent = await context.read(undefined, triggerOf(12, { meta: { kind: 'note', issueId: 12, journalId: 1003, messageId: 'journal:1003' } }),
      'parent', undefined, settings)
    expect(parent.messages.map(message => message.id)).toEqual(['journal:1001'])
    expect(JSON.stringify([thread, parent])).not.toContain('internal')
  })

  it('marks a user-less system journal as bot with from "system"', async () => {
    const { context, settings } = contextOf(issue(12, {
      journals: [
        journal(2001, { user: null, notes: 'Status set to In Progress', created_on: '2026-11-02T10:00:00+08:00' }),
      ],
    }))
    const page = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(page.messages[1]).toEqual({
      id: 'journal:2001',
      from: 'system',
      at: '2026-11-02T02:00:00.000Z',
      text: 'Status set to In Progress',
      bot: true,
      url: 'http://redmine.test/issues/12#note-2001',
    })
    expect(page.messages[0]!.from).toBe('Alice')
  })

  it('reports the issue metadata as the page body, omitting values Redmine does not return', async () => {
    const { context, settings } = contextOf(issue(12, { author: null, status: null, tracker: null }))
    const page = await context.read(undefined, triggerOf(12), 'thread', undefined, settings)
    expect(page.body).toEqual({ subject: 'Issue 12', url: 'http://redmine.test/issues/12' })
    const full = contextOf(issue(12))
    const withMeta = await full.context.read(undefined, triggerOf(12), 'thread', undefined, full.settings)
    expect(withMeta.body).toEqual({
      subject: 'Issue 12',
      status: 'In Progress',
      tracker: 'Bug',
      author: 'Alice',
      url: 'http://redmine.test/issues/12',
    })
  })
})

describe('read(root) and read(parent)', () => {
  const detail = issue(12, {
    description: 'Something is broken',
    journals: [
      journal(1001, { notes: 'first note', created_on: '2026-11-02T10:00:00+08:00' }),
      journal(1002, { notes: 'second note', created_on: '2026-11-02T10:10:00+08:00' }),
    ],
  })

  it('returns the issue subject and description as the root (T-37)', async () => {
    const { context, settings } = contextOf(detail)
    const page = await context.read(undefined, triggerOf(12), 'root', undefined, settings)
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]).toEqual({
      id: 'issue:12',
      from: 'Alice',
      at: '2026-11-02T01:00:00.000Z',
      text: 'Issue 12\n\nSomething is broken',
      url: 'http://redmine.test/issues/12',
    })
    expect(page.body).toMatchObject({ subject: 'Issue 12', status: 'In Progress', tracker: 'Bug', author: 'Alice' })
  })

  it('returns the message immediately before the trigger message (T-37)', async () => {
    const { context, settings } = contextOf(detail)
    const page = await context.read(undefined, triggerOf(12, { meta: { issueId: 12, messageId: 'journal:1002' } }),
      'parent', undefined, settings)
    expect(page.messages).toEqual([{
      id: 'journal:1001',
      from: 'Alice',
      at: '2026-11-02T02:00:00.000Z',
      text: 'first note',
      url: 'http://redmine.test/issues/12#note-1001',
    }])
    expect(page.body).toMatchObject({ subject: 'Issue 12' })
    expect(page.status).toBeUndefined()
  })

  it('reports no_parent instead of throwing for the root, an unknown message, or an empty thread (T-37)', async () => {
    const { context, settings } = contextOf(detail)
    const atRoot = await context.read(undefined, triggerOf(12), 'parent', undefined, settings)
    expect(atRoot).toEqual({ messages: [], body: { status: 'no_parent' }, status: 'no_parent' })
    const unknown = await context.read(undefined, triggerOf(12, { meta: { issueId: 12, messageId: 'journal:9999' } }),
      'parent', undefined, settings)
    expect(unknown).toEqual({ messages: [], body: { status: 'no_parent' }, status: 'no_parent' })
    const empty = contextOf(issue(12))
    const emptyParent = await empty.context.read(undefined, triggerOf(12, { meta: { issueId: 12, messageId: 'journal:1' } }),
      'parent', undefined, empty.settings)
    expect(emptyParent).toEqual({ messages: [], body: { status: 'no_parent' }, status: 'no_parent' })
  })
})

describe('threadContext.images', () => {
  it('delegates to the synchronous imageKeys extractor (T-30 / T-31)', () => {
    const { context } = contextOf(issue(12))
    const text = 'see <img src="/attachments/download/456/foo.png"> and !bar.jpg!'
    expect(context.images?.(text)).toEqual(imageKeys(text))
    expect(context.images?.(text)).toEqual(['att:456', 'file:bar.jpg'])
  })
})
