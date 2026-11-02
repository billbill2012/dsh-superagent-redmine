/**
 * Stable content-derived identifiers; equal inputs always produce the same id.
 * The host has its own copy, but importing it would pull the whole application into this plugin.
 */
import { createHash } from 'node:crypto'

export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}
