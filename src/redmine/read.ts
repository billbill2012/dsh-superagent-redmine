/**
 * Redmine thread context: an issue's description is the thread root and every journal (comment or system entry) is
 * one following message, ordered by `created_on` then `id`.
 *
 * Messages are normalized to the model-facing `ContextMessage` shape instead of exposing raw Redmine records: the
 * journal's user is reduced to a display name, timestamps become UTC ISO strings, and a journal without a user is
 * marked `bot` because a system entry can never authorize work. `read` also receives the configuration, while
 * `image` does not (B1) — the latter delegates to the image reader with this factory's lazy accessors.
 */
import type { RedmineConfig } from '../config.ts'
import type { ContextMessage, ThreadContext, Trigger } from '../contract.ts'
import type { ClientProvider } from './client.ts'
import { readImage } from './images.ts'
import { redmineTime } from './time.ts'
import { imageKeys, issueUrl } from './trigger.ts'
import type { RedmineIssue, RedmineJournal } from './types.ts'

export interface ReadOptions {
  /** Current configuration, or undefined while the Source is off; used by `image` only. */
  config(): RedmineConfig | undefined
  /** Builds a Redmine client for a configuration. */
  clients: ClientProvider
}

/** Journal pages are bounded by the Host; 50 keeps a long issue readable without flooding the model. */
const PAGE_SIZE = 50

/**
 * Builds the thread context reader for the Redmine Source.
 * @throws from `read` when the Trigger carries no issue id, and from `image` when the Source is not configured.
 */
export function createThreadContext(options: ReadOptions): ThreadContext<RedmineConfig> {
  return {
    messageId: messageIdOf,
    async read(_commands, trigger, part, cursor, config) {
      const issueId = issueIdOf(trigger)
      const client = options.clients(config)
      const issue = await client.issue(issueId, ['journals', 'attachments'])
      const url = issueUrl(config.baseUrl, issue.id)
      const root = rootMessage(issue, url, config.timezone)
      const messages = [root, ...journalMessages(issue, url, config.timezone)]
      const body = threadBody(issue, url)
      if (part === 'root') return { messages: [root], body }
      if (part === 'parent') {
        // The message immediately before the Trigger's own message; the root has no parent, and a Trigger whose
        // message is no longer visible (or a missing id) degrades to `no_parent` rather than failing (T-37).
        const index = messages.findIndex(message => message.id === messageIdOf(trigger))
        const parent = index > 0 ? messages[index - 1] : undefined
        if (!parent) return { messages: [], body: { status: 'no_parent' }, status: 'no_parent' }
        return { messages: [parent], body }
      }
      const offset = cursorOffset(cursor)
      const page = messages.slice(offset, offset + PAGE_SIZE)
      const next = offset + PAGE_SIZE < messages.length ? String(offset + PAGE_SIZE) : undefined
      return { messages: page, ...next ? { next } : {}, body }
    },
    // Synchronous by contract: `file:` names are resolved against the issue's attachments when the image is read.
    images: text => imageKeys(text),
    // `image` has no configuration parameter (B1); the closure supplies the current one to the reader.
    image: (agent, _commands, trigger, message, key, stateDir, signal) =>
      readImage(options, agent, trigger, message, key, stateDir, signal),
  }
}

/** The model-facing issue root; its text keeps the subject and description together as the thread's first message. */
function rootMessage(issue: RedmineIssue, url: string, timeZone: string): ContextMessage {
  return {
    id: `issue:${issue.id}`,
    from: issue.author?.name ?? 'unknown',
    at: redmineTime(issue.created_on, timeZone),
    text: `${issue.subject}\n\n${issue.description ?? ''}`.trim(),
    url,
  }
}

/**
 * Every public journal, oldest first; a journal created in the same second is ordered by id, matching the poller
 * (T-14). A private note is a team-internal remark (B14): it never becomes a Trigger, and it must not reach the model
 * through the context reader either, or an assessment could quote it in a public reply.
 */
function journalMessages(issue: RedmineIssue, url: string, timeZone: string): ContextMessage[] {
  const ordered = (issue.journals ?? []).map(journal => ({ journal, at: Date.parse(redmineTime(journal.created_on, timeZone)) }))
    .sort((a, b) => a.at - b.at || a.journal.id - b.journal.id)
  return ordered.filter(entry => entry.journal.private_notes !== true).map(({ journal }) => journalMessage(journal, url, timeZone))
}

function journalMessage(journal: RedmineJournal, issueUrlValue: string, timeZone: string): ContextMessage {
  const author = journal.user
  return {
    id: `journal:${journal.id}`,
    from: author?.name ?? 'system',
    at: redmineTime(journal.created_on, timeZone),
    text: journal.notes ?? '',
    // Status changes, assignments, and attachment uploads are system entries; they must never look human.
    ...author ? {} : { bot: true },
    url: `${issueUrlValue}#note-${journal.id}`,
  }
}

/** Issue metadata shown beside every page of the thread; absent fields are omitted rather than rendered as null. */
function threadBody(issue: RedmineIssue, url: string): Record<string, unknown> {
  return {
    subject: issue.subject,
    ...issue.status?.name ? { status: issue.status.name } : {},
    ...issue.tracker?.name ? { tracker: issue.tracker.name } : {},
    ...issue.author?.name ? { author: issue.author.name } : {},
    url,
  }
}

/** The page offset; anything that is not a non-negative integer reads page one so a bad cursor cannot stall a read. */
function cursorOffset(cursor: string | undefined): number {
  const offset = Number(cursor ?? '0')
  return Number.isInteger(offset) && offset > 0 ? offset : 0
}

/**
 * The Trigger's own message id (`issue:<id>` / `journal:<id>`). The poller records it in `meta.messageId`; a Trigger
 * that predates that field falls back to the issue root, the only message whose id is derivable from the Thread (B5).
 */
function messageIdOf(trigger: Trigger): string {
  const explicit = trigger.meta.messageId
  return explicit === undefined || explicit === null || explicit === '' ? `issue:${issueIdOf(trigger)}` : String(explicit)
}

/** The issue a Trigger belongs to: `meta.issueId` first, then the thread's source id written by the poller. */
function issueIdOf(trigger: Trigger): number {
  const candidates: unknown[] = [trigger.meta.issueId, trigger.threads[0]?.id]
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' && typeof candidate !== 'string') continue
    const issueId = Number(candidate)
    if (Number.isInteger(issueId) && issueId > 0) return issueId
  }
  throw new Error('The Redmine trigger has no issue id')
}
