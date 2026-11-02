import { describe, expect, it } from 'vitest'
import { RedmineConfigSchema, SOURCE } from '../src/config.ts'
import { createRedmine, type KindHost } from '../src/kind.ts'
import { cursorKey } from '../src/redmine/poll.ts'
import type { Trigger } from '../src/contract.ts'

const emptyHost: KindHost = { config: () => RedmineConfigSchema.parse({}) }
const configuredHost = (overrides: Record<string, unknown> = {}): KindHost => ({
  config: () => RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test', ...overrides }),
})

describe('configuration contract', () => {
  it('parses an empty object into full defaults, so the settings card cannot 500 (C-01)', () => {
    const parsed = RedmineConfigSchema.parse({})
    expect(parsed).toEqual({
      baseUrl: '', projectId: '', apiKeyEnv: 'REDMINE_API_KEY', mention: '@dsh', pollSeconds: 60,
      failuresBeforeError: 3, overlapSeconds: 120, writeBack: 'notes', timezone: '',
      observeIssues: false, observeNotes: false, assigned: true,
    })
  })

  it('still rejects unknown keys and out-of-range values', () => {
    expect(() => RedmineConfigSchema.parse({ nope: 1 })).toThrow()
    expect(() => RedmineConfigSchema.parse({ pollSeconds: 5 })).toThrow()
    expect(() => RedmineConfigSchema.parse({ writeBack: 'email' })).toThrow()
  })

  it('declares one panel field for every configuration key', () => {
    const runtime = createRedmine(emptyHost)
    const keys = new Set(runtime.kind.fields.map(field => field.key))
    for (const key of Object.keys(RedmineConfigSchema.parse({}))) {
      expect(keys.has(key), `missing field for ${key}`).toBe(true)
    }
    expect([...keys].filter(key => ['account', 'project'].includes(key))).toHaveLength(2)
  })
})

describe('kind contract', () => {
  it('declares its own health entry and never claims a sync entry (C-02)', () => {
    const runtime = createRedmine(emptyHost)
    expect(runtime.kind.kind).toBe(SOURCE)
    expect(runtime.kind.health).toContain(SOURCE)
    expect(runtime.kind.health.some(entry => entry.startsWith('sync:'))).toBe(false)
    expect(runtime.kind.title).toEqual({ zh: 'Redmine', en: 'Redmine' })
  })

  it('puts the allowed list first in the policy and keys it by numeric user id (C-03)', () => {
    const { policy } = createRedmine(emptyHost).kind
    expect(policy?.fields[0]?.key).toBe('allowed')
    expect(policy?.schema.parse({})).toEqual({ allowed: [] })
    expect(policy?.schema.parse({ allowed: [{ id: '7', name: 'Alice' }] })).toEqual({ allowed: [{ id: '7', name: 'Alice' }] })
    expect(() => policy?.schema.parse({ allowed: [{ id: 'alice' }] })).toThrow()
    expect(policy?.rows?.({})).toEqual([
      { id: 'issues', label: { zh: '新 Issue', en: 'New issues' }, note: { zh: '仅点名', en: 'Mentioned only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'notes', label: { zh: '评论', en: 'Comments' }, note: { zh: '仅点名', en: 'Mentioned only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ])
    expect(policy?.rows?.({ observeIssues: true, observeNotes: true })[0]?.cells).toEqual({
      listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true,
    })
  })

  it('scopes issues and notes by kind, and observes them only when the switch is on (C-04)', () => {
    const off = createRedmine(emptyHost).kind
    expect(off.scope!({ meta: { kind: 'note' } }, RedmineConfigSchema.parse({}))).toEqual({ listened: true, observed: false, row: 'notes' })
    expect(off.scope!({ meta: { kind: 'issue' } }, RedmineConfigSchema.parse({}))).toEqual({ listened: true, observed: false, row: 'issues' })
    expect(off.scope!({ meta: { kind: 'unknown' } }, RedmineConfigSchema.parse({}))).toEqual({ listened: true, observed: false })
    const on = createRedmine(emptyHost).kind
    expect(on.scope!({ meta: { kind: 'note' } }, RedmineConfigSchema.parse({ observeNotes: true }))).toEqual({ listened: true, observed: true, row: 'notes' })
  })

  it('provides a channel, a thread context reader, and an environment (C-05)', () => {
    const runtime = createRedmine(emptyHost)
    expect(runtime.kind.channel).toBeDefined()
    expect(runtime.kind.threadContext).toBeDefined()
    expect(runtime.kind.environment?.variables.map(variable => variable.key)).toEqual([
      'DSH_SUPERAGENT_REDMINE_URL', 'DSH_SUPERAGENT_REDMINE_PROJECT', 'DSH_SUPERAGENT_REDMINE_ISSUE',
    ])
    const config = RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test' })
    const values = runtime.kind.environment!.values({ deployment: undefined, config })
    expect(values).toMatchObject({ DSH_SUPERAGENT_REDMINE_URL: 'http://redmine.test', DSH_SUPERAGENT_REDMINE_PROJECT: 'dsh-test',
      DSH_SUPERAGENT_REDMINE_ISSUE: '' })
    const trigger: Trigger = { id: 't', source: SOURCE, threads: [{ source: SOURCE, id: '12' }], actor: { source: SOURCE, id: '7' },
      human: true, at: '', text: '', meta: { issueId: 12 } }
    expect(runtime.kind.environment!.values({ deployment: undefined, config, trigger }).DSH_SUPERAGENT_REDMINE_ISSUE).toBe('12')
  })

  it('shows no facts until the poller validates, then shows the account and project', () => {
    const runtime = createRedmine(configuredHost())
    expect(runtime.facts()).toEqual({})
    runtime.setFactsSource(() => ({ account: 'Connected as dsh-agent', project: 'My Project' }))
    expect(runtime.facts()).toEqual({ account: 'Connected as dsh-agent', project: 'My Project' })
  })

  it('keys the read cursor by the configured project, namespaced to this Source (B-note)', () => {
    expect(cursorKey(RedmineConfigSchema.parse({ projectId: 'dsh-test' }))).toBe('redmine:since:dsh-test')
  })
})
