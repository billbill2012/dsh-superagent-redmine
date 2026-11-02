/**
 * Source configuration schema and defaults.
 *
 * Every field has a default: the host calls `schema.parse({})` while resolving an instance that has no stored
 * configuration, and a throw there fails the whole settings view. An empty `baseUrl` or `projectId` therefore means
 * "not configured yet" and is rejected by the polling loop instead of by the schema.
 */
import { z } from 'zod'

export const SOURCE = 'redmine'

export const RedmineConfigSchema = z.object({
  baseUrl: z.string().trim().default(''),
  projectId: z.string().trim().default(''),
  apiKeyEnv: z.string().trim().default('REDMINE_API_KEY'),
  mention: z.string().trim().default('@dsh'),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  overlapSeconds: z.number().int().min(0).max(600).default(120),
  writeBack: z.enum(['notes', 'off']).default('notes'),
  timezone: z.string().trim().default(''),
  observeIssues: z.boolean().default(false),
  observeNotes: z.boolean().default(false),
  assigned: z.boolean().default(true),
}).strict()

export type RedmineConfig = z.infer<typeof RedmineConfigSchema>

/** True when the card has enough information to reach a Redmine instance. */
export function configured(config: RedmineConfig): boolean {
  return config.baseUrl !== '' && config.projectId !== ''
}
