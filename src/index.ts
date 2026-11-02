/**
 * Plugin entry: registers the Redmine SourceKind on the host's `orchestrator` service and runs its polling loop.
 *
 * `inject` lets cordis defer this plugin until dsh-superagent provides that service; nothing here imports the host's
 * runtime modules, so the plugin stays a standalone package.
 */
import { SOURCE, type RedmineConfig } from './config.ts'
import type { PluginContext, SourceContext } from './contract.ts'
import { createRedmine, type RedmineRuntime } from './kind.ts'
import { RedminePoller } from './redmine/poll.ts'

export const name = 'dsh-superagent-redmine'
export const inject = ['orchestrator']

export function apply(ctx: PluginContext): void {
  const runtime = createRedmine({ config: () => currentConfig(ctx) })
  ctx.effect(() => ctx.orchestrator.sources.register(runtime.kind), 'redmine: source kind')
  ctx.effect(() => {
    const source = ctx.orchestrator.context(runtime.kind)
    const controller = new AbortController()
    const poller = createPoller(source, runtime)
    runtime.setFactsSource(() => poller.facts)
    // An unhandled rejection would terminate DSH, so a failure escaping the loop is reported as Source health instead.
    const running = watch(source, poller, runtime.config, controller.signal).catch((error: unknown) => {
      source.report('redmine', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

/** Reads the live configuration; an empty URL or project is "not set up yet", not a schema error. */
export function currentConfig(ctx: PluginContext): RedmineConfig | undefined {
  return ctx.orchestrator.context({ kind: SOURCE, health: ['redmine'] }).config<RedmineConfig>(SOURCE)
}

/** Binds the poller to one registered Source context. */
export function createPoller(source: SourceContext, runtime: RedmineRuntime): RedminePoller {
  return new RedminePoller({
    state: source.state,
    receive: trigger => source.receive(trigger),
    report: (entry, health) => source.report(entry, health),
    describe: (key, description) => source.threads.describe(key, description),
  }, { config: runtime.config, clients: config => runtime.clients.get(config) })
}

/**
 * Polls until `signal` aborts. Setup gates every Source: while dsh-superagent itself is unconfigured nothing polls and
 * the card says so (02 §0.2), which is why the loop returns instead of retrying.
 */
export async function watch(source: SourceContext, poller: RedminePoller, config: () => RedmineConfig | undefined,
  signal: AbortSignal): Promise<void> {
  await source.ready
  if (!source.configured()) {
    source.report('redmine', { state: 'paused', detail: 'Waiting for the deployment check' })
    return
  }
  while (!signal.aborted) {
    await poller.poll(signal)
    if (signal.aborted) return
    await pause(Math.max(30, config()?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** Waits `ms` or until `signal` aborts, using the global timer so tests can drive it. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
