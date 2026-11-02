import { describe, expect, it } from 'vitest'
import { SOURCE } from '../src/config.ts'
import { imageKeys, issueTrigger, mentions, noteTrigger, triggersOf, type TriggerOptions } from '../src/redmine/trigger.ts'
import { agent, alice, issue, journal } from './helpers/fixtures.ts'

const options: TriggerOptions = {
  baseUrl: 'http://redmine.example.test',
  projectId: 'dsh-test',
  agentId: agent.id,
  mention: '@dsh',
  timezone: 'Asia/Shanghai',
  assigned: true,
}

describe('mentions', () => {
  it('matches the keyword on word boundaries, case-insensitively (T-09)', () => {
    expect(mentions('please @dsh fix this', '@dsh')).toBe(true)
    expect(mentions('@DSH fix this', '@dsh')).toBe(true)
    expect(mentions('hi @dsh', '@dsh')).toBe(true)
    expect(mentions('mail alice@dsh.example', '@dsh')).toBe(false)
    expect(mentions('@@dsh', '@dsh')).toBe(false)
    expect(mentions('@dsh2 please', '@dsh')).toBe(false)
  })

  it('escapes regular-expression characters in a configured mention', () => {
    expect(mentions('ping @dsh.bot now', '@dsh.bot')).toBe(true)
    expect(mentions('ping @dsh.botx now', '@dsh.bot')).toBe(false)
    expect(mentions('ping @dshXbot now', '@dsh.bot')).toBe(false)
  })
})

describe('issueTrigger', () => {
  it('maps a new issue with a mention (T-01)', () => {
    const trigger = issueTrigger(issue(12, { description: '@dsh please fix the header' }), options)
    expect(trigger).toMatchObject({
      source: SOURCE,
      threads: [{ source: SOURCE, id: '12' }],
      actor: { source: SOURCE, id: String(alice.id) },
      human: true,
      addressed: 'mention',
      at: '2026-11-02T01:00:00.000Z',
      text: 'Issue 12\n\n@dsh please fix the header',
      url: 'http://redmine.example.test/issues/12',
      channel: { source: SOURCE, thread: 'redmine:12', address: { issueId: '12', url: 'http://redmine.example.test/issues/12' } },
    })
    expect(trigger.meta).toMatchObject({ kind: 'issue', issueId: 12, messageId: 'issue:12' })
  })

  it('marks an issue created assigned to the agent as a direct request (T-08)', () => {
    expect(issueTrigger(issue(12, { assigned_to: agent }), options).addressed).toBe('direct')
    expect(issueTrigger(issue(12, { assigned_to: agent }), { ...options, assigned: false }).addressed).toBeUndefined()
  })

  it('produces the same id for the same issue (T-04)', () => {
    expect(issueTrigger(issue(12), options).id).toBe(issueTrigger(issue(12, { updated_on: '2027-01-01T00:00:00Z' }), options).id)
  })

  it('does not treat an issue authored by the agent as human', () => {
    expect(issueTrigger(issue(12, { author: agent }), options).human).toBe(false)
  })
})

describe('noteTrigger', () => {
  it('maps a journal with a mention (T-02)', () => {
    const trigger = noteTrigger(issue(12), journal(4567), options)!
    expect(trigger).toMatchObject({
      source: SOURCE,
      threads: [{ source: SOURCE, id: '12' }],
      actor: { source: SOURCE, id: String(alice.id) },
      human: true,
      addressed: 'mention',
      at: '2026-11-02T02:00:00.000Z',
      text: '@dsh fix this',
      url: 'http://redmine.example.test/issues/12#note-4567',
    })
    expect(trigger.meta).toMatchObject({ kind: 'note', issueId: 12, journalId: 4567, messageId: 'journal:4567' })
  })

  it('skips the agent\'s own notes, system entries, private notes, and empty entries (T-03, T-06, T-06b)', () => {
    expect(noteTrigger(issue(12), journal(1, { user: agent }), options)).toBeUndefined()
    expect(noteTrigger(issue(12), journal(1, { user: null }), options)).toBeUndefined()
    expect(noteTrigger(issue(12), journal(1, { private_notes: true }), options)).toBeUndefined()
    expect(noteTrigger(issue(12), journal(1, { notes: '   ' }), options)).toBeUndefined()
    expect(noteTrigger(issue(12), journal(1, { notes: null }), options)).toBeUndefined()
  })

  it('treats an assignment of the issue to the agent as a direct request (T-07)', () => {
    const assignment = journal(4567, { notes: 'Alice assigned this to the agent', details: [
      { property: 'attr', name: 'assigned_to_id', old_value: '7', new_value: String(agent.id) },
    ] })
    expect(noteTrigger(issue(12, { assigned_to: agent }), assignment, options)).toMatchObject({
      addressed: 'direct',
      actor: { source: SOURCE, id: String(alice.id) },
    })
    expect(noteTrigger(issue(12, { assigned_to: agent }), assignment, { ...options, assigned: false })?.addressed).toBeUndefined()
  })

  it('creates a trigger for an assignment entry that carries no comment, but not for other empty entries', () => {
    const assignment = journal(4567, { notes: '', details: [
      { property: 'attr', name: 'assigned_to_id', old_value: '7', new_value: String(agent.id) },
    ] })
    const trigger = noteTrigger(issue(12, { assigned_to: agent }), assignment, options)!
    expect(trigger.addressed).toBe('direct')
    expect(trigger.text).toBe('Assigned to the agent: Issue 12')
    const status = journal(4568, { notes: '', details: [{ property: 'attr', name: 'status_id', old_value: '1', new_value: '2' }] })
    expect(noteTrigger(issue(12, { assigned_to: agent }), status, options)).toBeUndefined()
  })
})

describe('triggersOf', () => {
  it('orders journals and applies the window, so the first run does not backfill (T-18)', () => {
    const detail = issue(12, {
      created_on: '2026-11-02T09:00:00+08:00',
      journals: [
        journal(2, { created_on: '2026-11-02T10:00:00+08:00' }),
        journal(1, { created_on: '2026-11-02T09:30:00+08:00', notes: 'old note' }),
      ],
    })
    const since = Date.parse('2026-11-02T09:45:00+08:00')
    const set = triggersOf(detail, options, since)
    expect(set.issue).toBeUndefined()
    expect(set.notes.map(trigger => trigger.meta.journalId)).toEqual([2])
  })

  it('keeps two journals created in the same second, in id order (T-14)', () => {
    const detail = issue(12, {
      created_on: '2026-11-02T09:00:00+08:00',
      journals: [
        journal(9, { created_on: '2026-11-02T10:00:00+08:00' }),
        journal(8, { created_on: '2026-11-02T10:00:00+08:00' }),
      ],
    })
    const set = triggersOf(detail, options, Date.parse('2026-11-02T09:00:00+08:00'))
    expect(set.notes.map(trigger => trigger.meta.journalId)).toEqual([8, 9])
  })
})

describe('imageKeys', () => {
  it('extracts attachment ids from <img> tags in every Redmine spelling (T-30)', () => {
    expect(imageKeys('<p><img src="/attachments/download/456/foo.png" alt="x"></p>')).toEqual(['att:456'])
    expect(imageKeys('<img src="/attachments/thumbnail/457/foo.png">')).toEqual(['att:457'])
    expect(imageKeys('<img src="/attachments/thumbnails/458/foo.png">')).toEqual(['att:458'])
    expect(imageKeys('<img src="http://internal:3000/attachments/download/459/foo.png">')).toEqual(['att:459'])
    expect(imageKeys("<img src='/attachments/download/460/foo.png'>")).toEqual(['att:460'])
  })

  it('extracts wiki image names, including alignment and width options (T-31)', () => {
    expect(imageKeys('see !foo.png!')).toEqual(['file:foo.png'])
    expect(imageKeys('!>bar.jpg! and !{width:120px}baz.gif!')).toEqual(['file:bar.jpg', 'file:baz.gif'])
    expect(imageKeys('attachment:shot.webp')).toEqual(['file:shot.webp'])
    expect(imageKeys('attachment:notes.pdf')).toEqual([])
    expect(imageKeys('!foo.txt!')).toEqual([])
  })

  it('keeps the file name when sentence punctuation follows the wiki spelling (T-31)', () => {
    expect(imageKeys('see attachment:foo.png, then more')).toEqual(['file:foo.png'])
    expect(imageKeys('attached as attachment:shot.jpg.')).toEqual(['file:shot.jpg'])
    expect(imageKeys('见 attachment:截图.webp，谢谢')).toEqual(['file:截图.webp'])
    expect(imageKeys('attachment:foo.png;')).toEqual(['file:foo.png'])
  })

  it('offers only extensions the image reader can actually resolve', () => {
    expect(imageKeys('!drawing.bmp! and attachment:vector.svg')).toEqual([])
    expect(imageKeys('<img src="/attachments/download/456/drawing.bmp">')).toEqual([])
    expect(imageKeys('<img src="/attachments/download/457/vector.svg">')).toEqual([])
    expect(imageKeys('<img src="/attachments/download/458/report.pdf">')).toEqual([])
    expect(imageKeys('<img src="/attachments/download/459/SHOT.PNG">')).toEqual(['att:459'])
    // No file name, a thumbnail size segment, or an extension-less name: the type is unknown here and the reader
    // decides from the attachment metadata after the read.
    expect(imageKeys('<img src="/attachments/download/460">')).toEqual(['att:460'])
    expect(imageKeys('<img src="/attachments/thumbnail/461/200">')).toEqual(['att:461'])
    expect(imageKeys('<img src="/attachments/thumbnail/462/300?x=1">')).toEqual(['att:462'])
    expect(imageKeys('<img src="/attachments/download/463/screenshot">')).toEqual(['att:463'])
  })

  it('deduplicates and ignores ordinary text', () => {
    expect(imageKeys('<img src="/attachments/download/1/a.png"><img src="/attachments/download/1/a.png">')).toEqual(['att:1'])
    expect(imageKeys('nothing to see here')).toEqual([])
    expect(imageKeys('')).toEqual([])
  })
})
