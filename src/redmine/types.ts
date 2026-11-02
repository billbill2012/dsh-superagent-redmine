/**
 * Zod schemas for the subset of Redmine's JSON API this plugin reads.
 *
 * The plugin runs against Redmine 2.3 and later, so only fields every version serializes are modelled: `id`, `name`,
 * `notes`, `created_on`, `vary details`, and `attachments`. Version-dependent fields (`status.is_closed`,
 * `journal.updated_on`, `journal.private_notes`) are optional. Records are loose: reading an older or newer instance
 * must not fail because of an unknown field.
 */
import { z } from 'zod'

export const RedmineUserSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
})

export const RedmineJournalDetailSchema = z.looseObject({
  property: z.string(),
  name: z.string(),
  old_value: z.string().nullish(),
  new_value: z.string().nullish(),
})

export const RedmineJournalSchema = z.looseObject({
  id: z.number(),
  user: RedmineUserSchema.nullish(),
  notes: z.string().nullish(),
  private_notes: z.boolean().nullish(),
  created_on: z.string(),
  details: z.array(RedmineJournalDetailSchema).nullish(),
})

export const RedmineAttachmentSchema = z.looseObject({
  id: z.number(),
  filename: z.string(),
  content_type: z.string().nullish(),
  filesize: z.number().nullish(),
  content_url: z.string().nullish(),
})

const NamedSchema = z.looseObject({ id: z.number(), name: z.string() })

export const RedmineIssueSchema = z.looseObject({
  id: z.number(),
  subject: z.string(),
  description: z.string().nullish(),
  project: NamedSchema.nullish(),
  tracker: NamedSchema.nullish(),
  status: NamedSchema.nullish(),
  author: RedmineUserSchema.nullish(),
  assigned_to: RedmineUserSchema.nullish(),
  created_on: z.string(),
  updated_on: z.string().nullish(),
  journals: z.array(RedmineJournalSchema).nullish(),
  attachments: z.array(RedmineAttachmentSchema).nullish(),
})

export const RedmineIssueRecordSchema = z.looseObject({ issue: RedmineIssueSchema })

export const RedmineIssueListSchema = z.looseObject({
  issues: z.array(RedmineIssueSchema),
  total_count: z.number(),
  offset: z.number().optional(),
  limit: z.number().optional(),
})

export const RedmineProjectSchema = z.looseObject({
  project: z.looseObject({ id: z.number(), identifier: z.string(), name: z.string() }),
})

export const RedmineCurrentUserSchema = z.looseObject({
  user: z.looseObject({
    id: z.number(),
    login: z.string(),
    firstname: z.string().nullish(),
    lastname: z.string().nullish(),
  }),
})

export const RedmineAttachmentRecordSchema = z.looseObject({ attachment: RedmineAttachmentSchema })

export type RedmineUser = z.infer<typeof RedmineUserSchema>
export type RedmineJournal = z.infer<typeof RedmineJournalSchema>
export type RedmineJournalDetail = z.infer<typeof RedmineJournalDetailSchema>
export type RedmineAttachment = z.infer<typeof RedmineAttachmentSchema>
export type RedmineIssue = z.infer<typeof RedmineIssueSchema>
export type RedmineIssueList = z.infer<typeof RedmineIssueListSchema>
export type RedmineProject = z.infer<typeof RedmineProjectSchema>['project']
export type RedmineCurrentUser = z.infer<typeof RedmineCurrentUserSchema>['user']
