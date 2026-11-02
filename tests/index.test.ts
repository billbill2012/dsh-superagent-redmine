import { describe, expect, it, vi } from 'vitest'
import { RedmineConfigSchema, SOURCE } from '../src/config.ts'
import type { Health, PluginContext, SourceContext, SourceKind } from '../src/contract.ts'
import { apply, currentConfig, inject, name, pause } from '../src/index.ts'

interface FakeHost {
  ctx: PluginContext
  registered: SourceKind[]
  reports: { entry: string; health: Health }[]
  disposers: (() => unknown)[]
}

/** A minimal cordis-shaped context: `effect` runs its body now and records the disposer it returns. */
function fakeHost(config: () => Record<string, unknown> | undefined, configured = true): FakeHost {
  const registered: SourceKind[] = []
  const reports: { entry: string; health: Health }[] = []
  const disposers: (() => unknown)[] = []
  const source: SourceContext = {
    ready: Promise.resolve(),
    configured: () => configured,
    config: <C extends Record<string, unknown>>() => config() as C | undefined,
    receive: () => 'stored',
    atomic: work => work(),
    state: { get: () => undefined, set: () => {} },
    threads: { describe: () => {} },
    report: (entry, health) => { reports.push({ entry, health }) },
  }
  const ctx = {
    effect(execute: () => unknown) {
      const dispose = execute()
      disposers.push(dispose as () => unknown)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    orchestrator: {
      sources: { register: (kind: SourceKind) => { registered.push(kind); return () => {} } },
      context: () => source,
    },
  } as unknown as PluginContext
  return { ctx, registered, reports, disposers }
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('plugin entry', () => {
  it('declares the injected service and a stable name', () => {
    expect(name).toBe('dsh-superagent-redmine')
    expect(inject).toEqual(['orchestrator'])
  })

  it('registers exactly one SourceKind and tears the loop down through its disposers', async () => {
    const host = fakeHost(() => undefined)
    apply(host.ctx)
    expect(host.registered).toHaveLength(1)
    expect(host.registered[0]!.kind).toBe(SOURCE)
    expect(host.registered[0]!.health).toEqual(['redmine'])
    expect(host.disposers).toHaveLength(2)
    await Promise.all(host.disposers.map(dispose => dispose()))
  })

  it('reports paused, without polling, while dsh-superagent setup is unfinished (02 §0.2)', async () => {
    const host = fakeHost(() => undefined, false)
    apply(host.ctx)
    await settle()
    expect(host.reports).toEqual([{ entry: 'redmine', health: { state: 'paused', detail: 'Waiting for the deployment check' } }])
    await Promise.all(host.disposers.map(dispose => dispose()))
  })

  it('reads the live configuration from the Source context, and undefined while it is off', () => {
    const enabled = fakeHost(() => RedmineConfigSchema.parse({ baseUrl: 'http://redmine.test', projectId: 'dsh-test' }))
    expect(currentConfig(enabled.ctx)).toMatchObject({ baseUrl: 'http://redmine.test', projectId: 'dsh-test' })
    const disabled = fakeHost(() => undefined)
    expect(currentConfig(disabled.ctx)).toBeUndefined()
  })
})

describe('pause', () => {
  it('resolves immediately for an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pause(60_000, controller.signal)).resolves.toBeUndefined()
  })

  it('resolves when the signal aborts before the delay elapses', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const waiting = pause(60_000, controller.signal)
      controller.abort()
      await expect(waiting).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
