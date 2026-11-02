/**
 * Local structural copy of the dsh-superagent Source plugin contract.
 *
 * The upstream contract (`src/sources/kind.ts`, `src/sources/host.ts`, and the domain types in `src/core/`) is not
 * exported from the package root, and depending on it at runtime would pull the whole host application into this
 * plugin. This file therefore restates only the shapes this plugin implements, so the plugin can be built and tested
 * on its own while remaining structurally compatible with the host. `@deepseek-ai/cordis` is imported for its types
 * only: the `Context` augmentation below is what makes `ctx.orchestrator` visible to the compiler.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'

export interface Localized {
  zh: string
  en: string
}

/** A configuration form field; `advanced` folds rarely changed fields behind the card's Advanced section. */
interface FieldBase {
  key: string
  label: Localized
  hint?: Localized
  advanced?: true
}

export type FieldSpec =
  | (FieldBase & { type: 'switch' })
  | (FieldBase & { type: 'select'; options: { value: string; label: Localized }[] })
  | (FieldBase & { type: 'number'; min: number; max: number })
  | (FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized })
  | (FieldBase & { type: 'fact'; settings?: 'deployment' })
  | (FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] })

/** An execution-environment variable a Source kind declares for workers. */
export interface VariableSpec {
  key: string
  description: Localized
}

export interface EnvironmentInput<C> {
  deployment: unknown
  config: C
  trigger?: Trigger
}

export interface AdmissionRowView {
  id: string
  label: Localized | string
  note: Localized
  cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean }
}

/** Policy extension for a Source kind: who may originate work, and how its admission rows render. */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  schema: z.ZodType<P>
  fields: FieldSpec[]
  explicit: Localized
  unnamed?: { person: Localized; bot: Localized }
  rows?(config: Record<string, unknown>): AdmissionRowView[]
}

export interface ChannelLink {
  url: string
  label: Localized
  triggerId?: string
}

export interface ThreadRef {
  source: string
  id: string
}

export interface ActorRef {
  source: string
  id: string
}

/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

/** A message for a Channel; `id` is what makes delivery idempotent. */
export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel<C> {
  allowed?(address: Record<string, string>, config: C): boolean
  send(host: unknown, message: OutboundMessage): Promise<'sent' | 'gone'>
  link(address: Record<string, string>, links: Record<string, unknown>): ChannelLink
}

export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: ActorRef
  human: boolean
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  meta: Record<string, unknown>
}

/** A normalized message returned by a thread context reader; `bot` marks a sender that can never authorize work. */
export interface ContextMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
  deleted?: true
  reply_to?: string
  url?: string
  path?: string
  line?: number
}

export type ContextPartName = 'thread' | 'root' | 'parent'

export interface ContextPart {
  messages: ContextMessage[]
  next?: string | undefined
  body: Record<string, unknown>
  status?: string
}

/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
export interface ThreadContext<C> {
  messageId(trigger: Trigger): string
  read(commands: unknown, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  images?(text: string): string[]
  image?(agent: unknown, commands: unknown, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}

export interface ThreadFact {
  label?: Localized | string
  value: Localized | string
  problem?: true
}

export type HealthState = 'starting' | 'ready' | 'paused' | 'error'

export interface Health {
  state: HealthState
  detail: string
  at?: string
}

/** Pluggable source kind descriptor registered with the host's SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  /** Read-only status facts; the host passes its Deployment, which this plugin does not use. */
  facts?(deployment: unknown): Record<string, Localized | string>
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Health entry names owned by this kind; no other kind or core loop may report them. */
  health: string[]
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: SourceChannel<C>
  threadContext?: ThreadContext<C>
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }

/** Source-scoped KV records (such as read cursors). */
export interface SourceState {
  get<V>(key: string): V | undefined
  set<V>(key: string, value: V | undefined): void
}

/** The source-scoped host capabilities this plugin uses; the rest of the upstream interface is not needed. */
export interface SourceContext {
  readonly ready: Promise<void>
  readonly problem?: unknown
  configured(): boolean
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  receive(trigger: Trigger): unknown | Promise<unknown>
  atomic<T>(work: () => T): T
  state: SourceState
  threads: {
    describe(key: string, description: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void
  }
  report(entry: string, health: Health): void
}

/** The host service dsh-superagent provides as the cordis `orchestrator` service. */
export interface SourceHost {
  readonly sources: { register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void }
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}

/** The cordis context a plugin's `apply` receives; the augmentation below adds the host service this plugin injects. */
export type PluginContext = Context

// Upstream declares this augmentation in its own compilation unit. A plugin compiled separately must repeat it,
// otherwise `ctx.orchestrator` is not part of `Context` in this program.
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly orchestrator: SourceHost
  }
}

/** Attachment service subset used to turn downloaded bytes into model-visible images. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ImageAttachmentRef {
  id: string
  mediaType: ImageMediaType
}

export interface AttachmentService {
  readonly imageLimits: { maxImageBytes: number; maxMessageImageBytes: number }
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name: string }): Promise<ImageAttachmentRef>
}

export interface LlmService {
  resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
}

/** The agent surface `threadContext.image` uses to check the model route and commit an attachment. */
export interface ImageAgent {
  ctx: { get(name: 'attachments'): AttachmentService | undefined; get(name: 'llm'): LlmService | undefined }
  session: { requestHeader(): { config?: { provider?: string; model?: string } } | undefined }
  options: { provider?: string; model?: string }
}
