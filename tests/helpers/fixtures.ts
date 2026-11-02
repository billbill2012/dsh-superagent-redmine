/** Shared Redmine fixtures for the unit tests. */
import type { RedmineAttachment, RedmineIssue, RedmineJournal, RedmineUser } from '../../src/redmine/types.ts'

export const alice: RedmineUser = { id: 7, name: 'Alice' }
export const bob: RedmineUser = { id: 8, name: 'Bob' }
export const agent: RedmineUser = { id: 9, name: 'dsh-agent' }

export function journal(id: number, overrides: Partial<RedmineJournal> = {}): RedmineJournal {
  return { id, user: alice, notes: '@dsh fix this', created_on: '2026-11-02T10:00:00+08:00', details: [], ...overrides }
}

export function issue(id: number, overrides: Partial<RedmineIssue> = {}): RedmineIssue {
  return {
    id,
    subject: `Issue ${id}`,
    description: 'Something is broken',
    project: { id: 1, name: 'dsh-test' },
    tracker: { id: 1, name: 'Bug' },
    status: { id: 2, name: 'In Progress' },
    author: alice,
    assigned_to: null,
    created_on: '2026-11-02T09:00:00+08:00',
    updated_on: '2026-11-02T10:00:00+08:00',
    journals: [],
    attachments: [],
    ...overrides,
  }
}

export function attachment(overrides: Partial<RedmineAttachment> & { id: number }): RedmineAttachment {
  return { filename: `shot-${overrides.id}.png`, content_type: 'image/png', filesize: 1024,
    content_url: `/attachments/download/${overrides.id}/${overrides.filename ?? `shot-${overrides.id}.png`}`, ...overrides }
}
