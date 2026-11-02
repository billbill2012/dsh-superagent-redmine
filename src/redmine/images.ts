/**
 * Redmine attachment → model-visible image for one `images(text)` key.
 *
 * The reader accepts only keys that occur in the message being inspected (T-35), resolves `att:<id>` through the
 * attachment endpoint and `file:<name>` through the issue's attachment list (T-31), downloads the original bytes
 * within the deployment limit (T-33), and commits them through the host's attachment service. A model that cannot
 * accept images is rejected up front (T-34); an unreadable attachment degrades to a readable error instead of
 * failing the whole assessment (T-23 / 03 §4).
 */
import type { RedmineConfig } from '../config.ts'
import type { ImageAgent, ImageMediaType, Trigger } from '../contract.ts'
import { RedmineError, type ClientProvider, type RedmineClient } from './client.ts'
import { imageKeys } from './trigger.ts'
import type { RedmineAttachment } from './types.ts'

export interface ImageOptions {
  /** Current configuration, or undefined while the Source is off. */
  config(): RedmineConfig | undefined
  /** Builds a Redmine client for a configuration. */
  clients: ClientProvider
}

/** Media types the attachment service can display, keyed by the `content_type` Redmine reports. */
const DECLARED_TYPES: Record<string, ImageMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** Media types inferred from a file extension when the record carries a generic or missing `content_type`. */
const EXTENSION_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Reads one image key of a message as a model-visible attachment.
 * @throws `Choose an image key from this source message` for a key the message does not contain, a readable error
 * for an unsupported model, image type, or unreadable attachment, and the downloader's size error over the limit.
 */
export async function readImage(options: ImageOptions, agent: unknown, trigger: Trigger, message: { id: string; text: string },
  key: string, stateDir: string, signal: AbortSignal): Promise<unknown> {
  // Keys are always paired with their source message, never accepted as arbitrary remote attachment ids (T-35).
  if (!imageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
  const config = options.config()
  if (!config) throw new Error('The Redmine Source is not configured')
  const imageAgent = agent as ImageAgent
  const attachments = imageAgent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const llm = imageAgent.ctx.get('llm')
  if (!llm) throw new Error('Image reading is unavailable: no model service is mounted')
  // The per-session route wins over the agent's default, exactly like the upstream Feishu image reader.
  const route = imageAgent.session.requestHeader()?.config
  const provider = route?.provider ?? imageAgent.options.provider
  const model = route?.model ?? imageAgent.options.model
  if (!provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) {
    throw new Error(`Model ${model} does not support image input（模型不支持图片输入）`)
  }
  const client = options.clients(config)
  const { attachment, contentUrl } = await readableAttachment(client, trigger, key)
  const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  const { data } = await client.download(contentUrl, { maxBytes, signal }).catch(error => {
    throw readableReadFailure(error)
  })
  // The declared media type wins; a generic `application/octet-stream` falls back to the file extension.
  const mediaType = mediaTypeOf(attachment)
  // Abort before committing so a cancelled assessment leaves no attachment behind.
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data, mediaType, name: attachment.filename })
  return { source_message_id: message.id, image_key: key, image }
}

/**
 * Resolves a key to the attachment record it names and a usable download URL: `att:<id>` directly, `file:<name>`
 * against the issue (T-31). Permission and missing-record failures become readable image errors.
 */
async function readableAttachment(client: RedmineClient, trigger: Trigger, key: string): Promise<{ attachment: RedmineAttachment; contentUrl: string }> {
  try {
    const found = await resolveAttachment(client, trigger, key)
    // `include=attachments` may omit `content_url` on older instances; the single-record endpoint fills it in.
    const attachment = found.content_url ? found : await client.attachment(found.id)
    if (!attachment.content_url) throw new Error(`The image could not be read: the attachment ${attachment.filename} has no download URL`)
    return { attachment, contentUrl: attachment.content_url }
  } catch (error) {
    throw readableReadFailure(error)
  }
}

/** Resolves a key to the attachment record it names: `att:<id>` directly, `file:<name>` against the issue (T-31). */
async function resolveAttachment(client: RedmineClient, trigger: Trigger, key: string): Promise<RedmineAttachment> {
  if (key.startsWith('att:')) return client.attachment(attachmentId(key.slice(4)))
  if (key.startsWith('file:')) return namedAttachment(client, trigger, key.slice(5))
  throw new Error(`Unsupported Redmine image key: ${key}`)
}

/**
 * Picks the attachment named by a `file:` key. Redmine keeps revisions of an upload as separate records, so the
 * largest id is the one the author most recently attached and therefore the one the wiki text means (T-31).
 */
async function namedAttachment(client: RedmineClient, trigger: Trigger, name: string): Promise<RedmineAttachment> {
  const issue = await client.issue(issueIdOf(trigger), ['attachments'])
  const latest = (issue.attachments ?? []).filter(item => item.filename === name)
    .reduce<RedmineAttachment | undefined>((best, item) => !best || item.id > best.id ? item : best, undefined)
  if (!latest) throw new Error(`The issue has no attachment named ${name}`)
  return latest
}

/** The numeric id of an `att:` key; `imageKeys` only emits digits, but a hand-built key must not reach `/attachments/NaN`. */
function attachmentId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`The image key is not a valid attachment id: ${raw}`)
  return id
}

/** The media type declared by Redmine, or the file extension when that declaration is missing or generic. */
function mediaTypeOf(attachment: RedmineAttachment): ImageMediaType {
  const declared = attachment.content_type?.split(';')[0]?.trim().toLowerCase()
  const byDeclaration = declared ? DECLARED_TYPES[declared] : undefined
  if (byDeclaration) return byDeclaration
  const extension = attachment.filename.slice(attachment.filename.lastIndexOf('.') + 1).toLowerCase()
  const byExtension = EXTENSION_TYPES[extension]
  if (byExtension) return byExtension
  throw new Error('The attachment is not a supported PNG/JPEG/WebP/GIF image')
}

/** Wraps an unavailable attachment (403/404) as a readable image failure; any other error keeps its own message. */
function readableReadFailure(error: unknown): Error {
  if (error instanceof RedmineError && (error.status === 403 || error.status === 404)) {
    return new Error(`The image could not be read: ${error.message}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** The issue the Trigger belongs to: `meta.issueId` first, then the thread's source id written by the poller. */
function issueIdOf(trigger: Trigger): number {
  const candidates: unknown[] = [trigger.meta.issueId, trigger.threads[0]?.id]
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' && typeof candidate !== 'string') continue
    const issueId = Number(candidate)
    if (Number.isInteger(issueId) && issueId > 0) return issueId
  }
  throw new Error('The Redmine trigger has no issue id')
}
