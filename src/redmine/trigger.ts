/**
 * Redmine issues and journal entries → domain Triggers.
 *
 * A Redmine issue is a Thread (`redmine:<id>`); its description is the thread root and every non-empty, non-private
 * journal is one message. Users are identified by their numeric id: issue and journal payloads carry `{ id, name }`
 * only — `login` is not serialized — so the allowed list and agent identity both use numeric ids.
 */
import { SOURCE } from '../config.ts'
import type { Trigger } from '../contract.ts'
import { key } from '../key.ts'
import { redmineTime } from './time.ts'
import type { RedmineIssue, RedmineJournal } from './types.ts'

export interface TriggerOptions {
  /** Configured Redmine root, used for page links only; callers pass it already normalized. */
  baseUrl: string
  /** Configured project, recorded in `meta` for the panel. */
  projectId: string
  /** Numeric id of the account the plugin runs as; its own notes never authorize work. */
  agentId: number
  /** Keyword that counts as addressing the agent, such as `@dsh`. Escaped before it becomes a pattern. */
  mention: string
  /** Zone used to read timestamps that carry no offset; empty means the process zone. */
  timezone: string
  /** Whether being assigned to the agent counts as a direct request. */
  assigned: boolean
}

/** The web page of one issue. */
export function issueUrl(baseUrl: string, issueId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/issues/${issueId}`
}

/** The web page of one note, anchored at the journal. */
export function noteUrl(baseUrl: string, issueId: number, journalId: number): string {
  return `${issueUrl(baseUrl, issueId)}#note-${journalId}`
}

/**
 * True when `text` mentions the agent. The mention is a configuration value, so it is escaped before it becomes a
 * pattern, and the boundaries keep `@dsh` from matching inside `@dsh.bot` or `@dsh2` (T-09).
 */
export function mentions(text: string, mention: string): boolean {
  if (!text || !mention) return false
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_@])${escaped}(?![A-Za-z0-9_-])`, 'i').test(text)
}

/** The channel every reply for this issue goes to. */
export function channelOf(baseUrl: string, issueId: number): Trigger['channel'] {
  return { source: SOURCE, thread: `${SOURCE}:${issueId}`, address: { issueId: String(issueId), url: issueUrl(baseUrl, issueId) } }
}

/** The thread key of an issue. */
export const threadKey = (issueId: number): string => `${SOURCE}:${issueId}`

/** The stable message id of a trigger within its thread (`issue:<id>` / `journal:<id>`). */
export const messageIdOf = (kind: 'issue' | 'note', id: number): string => `${kind === 'issue' ? 'issue' : 'journal'}:${id}`

/**
 * Builds the Trigger for a newly created issue. The id depends on the issue alone, so re-reading the issue — on every
 * round, or after a restart — produces a duplicate the engine drops.
 */
export function issueTrigger(issue: RedmineIssue, options: TriggerOptions): Trigger {
  const text = [issue.subject, issue.description ?? ''].filter(Boolean).join('\n\n').trim()
  const assigned = options.assigned && issue.assigned_to?.id === options.agentId
  const addressed = mentions(text, options.mention) ? 'mention' as const : assigned ? 'direct' as const : undefined
  return {
    id: key('redmine-issue', String(issue.id)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.id) }],
    actor: { source: SOURCE, id: String(issue.author?.id ?? '') },
    human: issue.author !== null && issue.author !== undefined && issue.author.id !== options.agentId,
    ...addressed ? { addressed } : {},
    at: redmineTime(issue.created_on, options.timezone),
    text,
    channel: channelOf(options.baseUrl, issue.id),
    url: issueUrl(options.baseUrl, issue.id),
    meta: {
      kind: 'issue',
      issueId: issue.id,
      messageId: messageIdOf('issue', issue.id),
      ...issue.author?.name ? { actorName: issue.author.name } : {},
      projectId: options.projectId,
      ...issue.tracker?.name ? { tracker: issue.tracker.name } : {},
      ...issue.status?.name ? { status: issue.status.name } : {},
    },
  }
}

/**
 * Builds the Trigger for one journal — a comment, or the assignment that hands the issue to the agent.
 * Returns undefined for a journal that can never authorize work: a system entry (no user), the agent's own note, a
 * private note (2.6–3.3 hide the flag from the API, see the compatibility notes), or an empty entry such as a status
 * change or an attachment upload.
 */
export function noteTrigger(issue: RedmineIssue, journal: RedmineJournal, options: TriggerOptions): Trigger | undefined {
  const author = journal.user
  if (!author || author.id === options.agentId) return undefined
  if (journal.private_notes === true) return undefined
  const notes = (journal.notes ?? '').trim()
  const assignedByEntry = options.assigned && (journal.details ?? []).some(detail =>
    detail.property === 'attr' && detail.name === 'assigned_to_id' && String(detail.new_value ?? '') === String(options.agentId))
  // An assignment that carries no comment is still a request; any other empty entry is not.
  if (!notes && !assignedByEntry) return undefined
  const assigned = options.assigned && issue.assigned_to?.id === options.agentId
  const addressed = mentions(notes, options.mention) ? 'mention' as const
    : assignedByEntry || assigned ? 'direct' as const : undefined
  const text = notes || `Assigned to the agent: ${issue.subject}`
  return {
    id: key('redmine-journal', String(issue.id), String(journal.id), journal.created_on),
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.id) }],
    actor: { source: SOURCE, id: String(author.id) },
    human: true,
    ...addressed ? { addressed } : {},
    at: redmineTime(journal.created_on, options.timezone),
    text,
    channel: channelOf(options.baseUrl, issue.id),
    url: noteUrl(options.baseUrl, issue.id, journal.id),
    meta: {
      kind: 'note',
      issueId: issue.id,
      journalId: journal.id,
      messageId: messageIdOf('note', journal.id),
      actorName: author.name,
      projectId: options.projectId,
      ...issue.tracker?.name ? { tracker: issue.tracker.name } : {},
      ...issue.status?.name ? { status: issue.status.name } : {},
    },
  }
}

export interface TriggerSet {
  issue?: Trigger
  notes: Trigger[]
}

/**
 * Maps one issue with its journals, oldest first. `since` is the round's window start in epoch milliseconds: older
 * journals are not replayed, so the first run does not backfill history (T-18).
 */
export function triggersOf(issue: RedmineIssue, options: TriggerOptions, since: number): TriggerSet {
  const journals = (issue.journals ?? []).flatMap(journal => {
    const at = Date.parse(redmineTime(journal.created_on, options.timezone))
    return Number.isFinite(at) ? [{ journal, at }] : []
  }).sort((a, b) => a.at - b.at || a.journal.id - b.journal.id)
  const notes = journals
    .filter(entry => entry.at >= since)
    .flatMap(entry => {
      const trigger = noteTrigger(issue, entry.journal, options)
      return trigger ? [trigger] : []
    })
  const created = Date.parse(redmineTime(issue.created_on, options.timezone))
  return { ...created >= since ? { issue: issueTrigger(issue, options) } : {}, notes }
}

/** File extensions this Source can actually hand to the model; the downloader validates the media type again. */
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i
/** Attachment paths in both the modern (`thumbnails`) and 2.3 (`thumbnail`) spellings; group 2 is the segment after
 * the id — a file name, a thumbnail size, or absent — and is only used to skip clearly non-image files. */
const ATTACHMENT_PATH = /\/attachments\/(?:download|thumbnail|thumbnails)\/(\d+)(?:\/([^?#\s]*))?/

/**
 * Image keys a message text offers: `att:<id>` for an attachment path (Redmine renders inline images as
 * `<img src="/attachments/...">`) and `file:<name>` for the wiki spellings `!name.png!` and `attachment:name.png`.
 * Synchronous by contract — a `file:` key is resolved against the issue's attachments when the image is read — and
 * deduplicated in first-seen order.
 */
export function imageKeys(text: string): string[] {
  if (!text) return []
  const found: string[] = []
  const add = (value: string): void => { if (!found.includes(value)) found.push(value) }
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["']?)([^"'\s>]+)\1/gi)) {
    const path = ATTACHMENT_PATH.exec(match[2] ?? '')
    const id = path?.[1]
    const file = path?.[2]
    // Only skip a segment that is clearly a non-image file name. A thumbnail's last segment may be a size (`/456/200`),
    // and a downloadable file may have no extension at all; both stay unknown here and are decided from the metadata.
    const named = file !== undefined && /\.[A-Za-z0-9]+$/.test(file)
    if (id && (!named || IMAGE_FILE.test(file))) add(`att:${id}`)
  }
  for (const match of text.matchAll(/!([^!\n]{1,500})!/g)) {
    const name = inlineName(match[1] ?? '')
    if (name) add(`file:${name}`)
  }
  // The name ends at its image extension, so sentence punctuation glued to the spelling (`attachment:foo.png,`) and
  // following prose are not swallowed into the file name.
  for (const match of text.matchAll(/\battachment:([^\s<>"'()[\]]+\.(?:png|jpe?g|webp|gif))(?![A-Za-z0-9])/gi)) {
    add(`file:${match[1]}`)
  }
  return found
}

/** Reads the file name out of Redmine's inline-image spelling, including alignment and width options. */
function inlineName(token: string): string | undefined {
  const name = token.trim()
    .replace(/^\{[^}]*\}/, '')
    .replace(/^[<>]+/, '')
    .replace(/\([^)]*\)\s*$/, '')
    .trim()
  return name && !/\s/.test(name) && IMAGE_FILE.test(name) ? name : undefined
}
