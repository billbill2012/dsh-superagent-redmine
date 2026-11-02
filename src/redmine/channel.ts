/**
 * Redmine write-back Channel: every outbound message becomes exactly one note on its issue.
 *
 * `send` and `link` receive no configuration (B1), so this factory closes over the Source's lazy configuration
 * accessor: the current URL, key, and `writeBack` switch are resolved on every call instead of being captured when
 * the Source kind is registered. `allowed` is the gate that keeps `writeBack=off` from ever reaching the Outbox, and
 * a hidden marker makes a retried delivery idempotent when the first write succeeded but its response timed out.
 */
import type { RedmineConfig } from '../config.ts'
import type { OutboundMessage, SourceChannel } from '../contract.ts'
import { RedmineError, type ClientProvider } from './client.ts'

export interface DeliveryOptions {
  /** Current configuration, or undefined while the Source is off. */
  config(): RedmineConfig | undefined
  /** Builds a Redmine client for a configuration; the channel itself caches nothing. */
  clients: ClientProvider
}

/**
 * The hidden marker identifying the OutboundMessage that produced a note. It is appended after the visible text, so
 * Redmine renders it as nothing while the plugin can still recognize its own writes after a retry (T-21).
 */
function deliveryMarker(messageId: string): string {
  return `<!-- dsh-redmine:${messageId} -->`
}

/**
 * Builds the Channel adapter for the Redmine Source.
 * @throws when a delivery is attempted while the Source is not configured.
 */
export function createChannel(options: DeliveryOptions): SourceChannel<RedmineConfig> {
  return {
    // The Outbox skips a channel that refuses its address, so `writeBack=off` means zero write requests, not a
    // send that fails late (T-22).
    allowed: (_address, config) => config.writeBack === 'notes',
    async send(_host, message) {
      const config = options.config()
      if (!config) throw new Error('The Redmine Source is not configured')
      // Defensive: `allowed` normally filters this out, but a message queued before the switch was turned off may
      // still be dispatched. It must be dropped rather than retried forever.
      if (config.writeBack === 'off') return 'gone'
      const issueId = issueIdOf(message)
      const client = options.clients(config)
      const marker = deliveryMarker(message.id)
      try {
        // A marker already present means the previous attempt wrote the note but never saw the response.
        const issue = await client.issue(issueId, ['journals'])
        if ((issue.journals ?? []).some(journal => (journal.notes ?? '').includes(marker))) return 'sent'
        await client.addNote(issueId, `${message.text}\n\n${marker}`)
        return 'sent'
      } catch (error) {
        // The issue no longer exists or this account can no longer see it; retrying cannot succeed (T-23).
        if (error instanceof RedmineError && (error.status === 403 || error.status === 404)) return 'gone'
        // Everything else (5xx, 429, timeouts, 422) is a real failure the Outbox should retry or surface (T-25).
        throw error
      }
    },
    // `link` gets the address only, so the page URL recorded by the Trigger is the only source of truth (B1).
    link: address => ({ url: address.url ?? '', label: { zh: '在 Redmine 查看', en: 'Open in Redmine' } }),
  }
}

/** Reads the issue id from the channel address, rejecting anything that is not a positive integer. */
function issueIdOf(message: OutboundMessage): number {
  const raw = message.channel.address.issueId
  const issueId = Number(raw)
  if (!raw || !Number.isInteger(issueId) || issueId <= 0) {
    throw new Error(`The Redmine channel address has no positive issue id: ${raw ?? ''}`)
  }
  return issueId
}
