/**
 * The Redmine SourceKind: configuration card, policy, receiving scope, reply channel, thread context, worker
 * environment, and the read-only facts on the card.
 *
 * The host hands `send` and `image` no configuration (see 02 §0.1 / B1), so both are built here as closures over
 * `host.config()`; they reread the live configuration on every call and therefore survive edits without a restart.
 */
import { z } from 'zod'
import { SOURCE, RedmineConfigSchema, type RedmineConfig } from './config.ts'
import type { FieldSpec, Localized, SourceKind } from './contract.ts'
import { createChannel } from './redmine/channel.ts'
import { RedmineClientFactory } from './redmine/client.ts'
import { createThreadContext } from './redmine/read.ts'

/** The one host capability the kind factory needs: the Source's live configuration, or undefined while it is off. */
export interface KindHost {
  config(): RedmineConfig | undefined
}

export interface RedmineOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface RedmineRuntime {
  readonly kind: SourceKind<RedmineConfig>
  /** One client per connection, shared by the channel, the context reader, and the poller. */
  readonly clients: RedmineClientFactory
  readonly config: () => RedmineConfig | undefined
  /** Installs the poller snapshot the card's facts read; until then the card shows no facts. */
  setFactsSource(source: () => Record<string, Localized | string>): void
  facts(): Record<string, Localized | string>
}

const fields: FieldSpec[] = [
  { key: 'baseUrl', type: 'text', label: { zh: 'Redmine 地址', en: 'Redmine URL' },
    hint: { zh: '例如 https://redmine.example.com 或内网 http://redmine.example.com。末尾斜杠会自动去掉；HTTP 只在 VPN/内网使用。',
      en: 'For example https://redmine.example.com or an intranet http://host. A trailing slash is dropped; plain HTTP is for a VPN or intranet only.' } },
  { key: 'projectId', type: 'text', label: { zh: '项目', en: 'Project' },
    hint: { zh: '项目标识（推荐，如 my-project）或数字 id。列表查询只接受数字，插件会在首次轮询时解析并缓存。',
      en: 'The project identifier (recommended, such as my-project) or its numeric id. Redmine only accepts a number when listing issues; the plugin resolves and caches it on the first poll.' } },
  { key: 'apiKeyEnv', type: 'text', label: { zh: 'API Key 的环境变量名', en: 'Environment variable holding the API key' },
    hint: { zh: '密钥本身不写入设置数据库。这个变量必须对 DSH 的启动环境可见。',
      en: 'The key itself is never stored in the settings database. The variable must be visible to the process that starts DSH.' } },
  { key: 'mention', type: 'text', label: { zh: '点名关键字', en: 'Mention keyword' },
    hint: { zh: 'issue 或评论正文里包含这个关键字，就视为明确请求智能体。按整词匹配，不区分大小写。',
      en: 'An issue or comment containing this keyword explicitly addresses the agent. Matched as a whole word, case-insensitively.' } },
  { key: 'observeIssues', type: 'switch', label: { zh: '接收没有点名的新 Issue', en: 'Receive new issues that do not mention the agent' },
    hint: { zh: '打开后，没有点名的新 issue 也进入接收范围，由策略的接收表决定是否成为候选。从打开时开始，不读以前的。',
      en: 'New issues that do not mention the agent are received too, and the Policy admission table decides whether they become candidates. Starts when switched on; earlier issues are not read.' } },
  { key: 'observeNotes', type: 'switch', label: { zh: '接收没有点名的评论', en: 'Receive comments that do not mention the agent' },
    hint: { zh: '打开后，没有点名的评论也进入接收范围，由策略的接收表决定是否成为候选。',
      en: 'Comments that do not mention the agent are received too, and the Policy admission table decides whether they become candidates.' } },
  { key: 'assigned', type: 'switch', label: { zh: '指派给智能体也算明确请求', en: 'Assignment to the agent counts as a request' },
    hint: { zh: 'issue 被指派给智能体账号时，等同于点名；只改派给别人、或指派给别人的评论不算。',
      en: 'An issue assigned to the agent account counts as addressing it. Assignments to anyone else do not.' } },
  { key: 'writeBack', type: 'select', label: { zh: '回写方式', en: 'Write-back' }, options: [
    { value: 'notes', label: { zh: '在 issue 下回评论', en: 'Add a note to the issue' } },
    { value: 'off', label: { zh: '只读，不回写', en: 'Read-only; never write' } },
  ], hint: { zh: '插件只会添加评论，永远不会修改状态、指派人或自定义字段。',
    en: 'The plugin only adds notes. It never changes status, assignee, or custom fields.' } },
  { key: 'pollSeconds', type: 'number', min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
    hint: { zh: '默认 60 秒。新 issue/评论通常在两个周期内成为工单。', en: 'Defaults to 60 seconds. A new issue or comment becomes a ticket within about two intervals.' } },
  { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
    hint: { zh: '单次网络中断会在下一轮自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  { key: 'overlapSeconds', type: 'number', advanced: true, min: 0, max: 600, label: { zh: '重叠窗口 / 秒', en: 'Overlap window / seconds' },
    hint: { zh: '每轮会重读游标之前这段时间的更新；重复项按稳定 id 去重。项目更新频繁时可调小。',
      en: 'Each poll re-reads updates from this long before the cursor; duplicates are dropped by stable ids. Lower it for a busy project.' } },
  { key: 'timezone', type: 'text', advanced: true, label: { zh: '时区', en: 'Time zone' },
    hint: { zh: 'Redmine 返回不带时区的时间时，按这个 IANA 时区解释（如 Asia/Shanghai）。留空表示使用进程时区。',
      en: 'Used to read timestamps Redmine returns without a zone, as an IANA zone such as Asia/Shanghai. Empty means the process zone.' } },
  { key: 'account', type: 'fact', label: { zh: '当前账号', en: 'Account' } },
  { key: 'project', type: 'fact', label: { zh: '当前项目', en: 'Project' } },
]

/** The Source policy: who may originate work, and how the two admission rows render. */
const policy = {
  schema: z.object({
    // Redmine serializes a user as `{ id, name }` only, so the list is keyed by the numeric id (B13).
    allowed: z.array(z.object({
      id: z.string().trim().regex(/^\d+$/, 'Use the numeric Redmine user id'),
      name: z.string().trim().max(100).optional(),
    }).strict()).default([]),
  }).strict(),
  fields: [{
    key: 'allowed', type: 'rows' as const,
    label: { zh: '能发起工作的 Redmine 用户', en: 'Redmine users who may originate work' },
    hint: { zh: '填数字用户 id（Redmine 个人资料页地址 /users/<id>）；名字只用于显示，可以留空。',
      en: 'Enter the numeric user id (from /users/<id> in Redmine); the name is for display only and may be empty.' },
    columns: [
      { key: 'id', type: 'text' as const, label: { zh: '用户 id', en: 'User id' }, pattern: '\\d+' },
      { key: 'name', type: 'text' as const, label: { zh: '名字', en: 'Name' }, optional: true },
    ],
  }],
  unnamed: { person: { zh: 'Redmine 用户', en: 'Redmine user' }, bot: { zh: 'Redmine 系统', en: 'Redmine system' } },
  explicit: { zh: '名单里的用户在 issue 或评论里点名智能体，或者 issue 被指派给智能体。',
    en: 'A user on the list mentions the agent in an issue or comment, or the issue is assigned to the agent.' },
  rows(stored: Record<string, unknown>) {
    const config = RedmineConfigSchema.partial().parse(stored)
    const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅点名', en: 'Mentioned only' }
    const row = (id: string, label: Localized, observed: boolean | undefined) => ({
      id, label, note: note(observed),
      cells: { listedUnaddressed: !!observed, unlistedAddressed: true, unlistedUnaddressed: !!observed },
    })
    return [row('issues', { zh: '新 Issue', en: 'New issues' }, config.observeIssues),
      row('notes', { zh: '评论', en: 'Comments' }, config.observeNotes)]
  },
}

/** Builds the runtime and its SourceKind; the caller registers the kind and starts the polling loop. */
export function createRedmine(host: KindHost, options: RedmineOptions = {}): RedmineRuntime {
  const clients = new RedmineClientFactory({ ...options.env === undefined ? {} : { env: options.env },
    ...options.fetch === undefined ? {} : { fetch: options.fetch }, ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs } })
  let factsSource: () => Record<string, Localized | string> = () => ({})
  let runtime: RedmineRuntime
  const kind: SourceKind<RedmineConfig> = {
    kind: SOURCE,
    title: { zh: 'Redmine', en: 'Redmine' },
    description: { zh: 'Redmine 项目里的 issue 与评论。智能体用自己的账号读取，结果以评论写回，从不修改状态或字段。',
      en: 'Issues and comments in one Redmine project. The agent reads with its own account and replies as notes; it never changes status or fields.' },
    schema: RedmineConfigSchema,
    fields,
    facts: () => runtime.facts(),
    health: ['redmine'],
    // The admission row follows the observation switch: an unaddressed message only reaches the gate when the Source
    // observes that scope (B4), so "mentions only" is a switch, never a table cell.
    scope: ({ meta }, config) => {
      const row = meta.kind === 'issue' ? 'issues' : meta.kind === 'note' ? 'notes' : undefined
      const observed = row === 'issues' ? config.observeIssues : row === 'notes' ? config.observeNotes : false
      return { listened: true, observed, ...row ? { row } : {} }
    },
    channel: createChannel({ config: host.config, clients: config => clients.get(config) }),
    threadContext: createThreadContext({ config: host.config, clients: config => clients.get(config) }),
    policy,
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_REDMINE_URL', description: { zh: '这个来源监听的 Redmine 根地址', en: 'Root URL of the Redmine instance this Source watches' } },
        { key: 'DSH_SUPERAGENT_REDMINE_PROJECT', description: { zh: '这个来源监听的 Redmine 项目', en: 'Redmine project this Source watches' } },
        { key: 'DSH_SUPERAGENT_REDMINE_ISSUE', description: { zh: '触发工单的 Redmine issue id；工单不是从 Redmine 来的时为空', en: 'Redmine issue id that started the ticket; empty when the ticket did not start in Redmine' } },
      ],
      values: ({ config, trigger }) => ({
        DSH_SUPERAGENT_REDMINE_URL: config.baseUrl,
        DSH_SUPERAGENT_REDMINE_PROJECT: config.projectId,
        DSH_SUPERAGENT_REDMINE_ISSUE: trigger?.threads[0]?.source === SOURCE && typeof trigger.meta.issueId === 'number'
          ? String(trigger.meta.issueId) : '',
      }),
    },
  }
  runtime = {
    kind,
    clients,
    config: host.config,
    setFactsSource: source => { factsSource = source },
    facts: () => ({ ...factsSource() }),
  }
  return runtime
}
