# 安装与上线

**中文** | [English](SETUP.en.md)

> 本文是 [README.md](README.md) 的部署展开版。设计与验收标准见 monorepo 本地 `docs/dsh-superagent-redmine/`（不随本包公开）。

## 0. 前置条件

| 依赖 | 要求 |
|---|---|
| Node.js | ≥ 22.19 或 ≥ 24（插件用内置 `fetch`） |
| DSH | 本机 `dsh --version` 与 `package.json` 的 `engines.dsh`（`^0.2.1-rc.3`）匹配 |
| dsh-superagent | 本机 `~/src/dsh-superagent`，**它自己的 setup 必须已完成**（GitHub 仓库 + agent CLI） |
| Redmine | 2.3+；一个专用 API 账号，项目内「查看问题 + 添加评论」即可 |
| 凭据 | 该账号的 API Key，放在环境变量里（默认 `REDMINE_API_KEY`） |

`ctx.configured()` 为 false 时宿主不会轮询任何 Source：此时卡片显示 `paused`，不是插件错误。

## 1. 构建

```sh
cd <插件仓库目录>           # 克隆后的目录；已在该目录时跳过
pnpm install
pnpm check            # typecheck + 测试 + 构建；产出 lib/index.js 与 lib/index.d.ts
```

## 2. 装进 profile

```sh
dsh plugin --profile superagent add "link:$PWD"
```

然后编辑 `~/.dsh/profiles/superagent/cordis.patch.yml`，在**末尾**追加插入项（profile patch 是配置叠加，
新增插件必须用 `insert`，直接写 `- id:` 会被当成修改已有项）：

```yaml
- insert:
    - id: dsh-superagent-redmine
      name: dsh-superagent-redmine
```

## 3. 提供 API Key

获取方式（截图 + 步骤）见 [README「获取 Redmine API Key」](README.md#获取-redmine-api-key)：
Redmine 右上角 **我的账号 → API 访问键 → 显示/重置**，复制 40 位 Key。

```sh
export REDMINE_API_KEY=xxxxxxxxxxxxxxxx
```

Redmine 2.3 若 `/users/current.json` 返回 404，请管理员在 **管理 → 配置 → API** 勾选「启用 REST API」。

Key 必须在 **DSH 启动的那个进程环境**里可见：tmux 会让新会话继承启动 tmux 的 shell 环境；
launchd/Finder 启动的进程不继承终端里 `export` 的变量，需要写进 launchd plist 或启动脚本。
插件只读取变量名，**不会把 Key 写进设置数据库**。

## 4. 重启并确认扩展点

```sh
cd ~/src/dsh-superagent && scripts/dsh-superagent restart
scripts/dsh-superagent status; echo "status=$?"     # 期望 0
```

- Settings → Sources 应出现 **Redmine** 卡片；
- 点开卡片（默认空配置）**不应报错**——所有配置字段都有默认值，`schema.parse({})` 不会抛；
- 面板的「执行环境」应列出 `DSH_SUPERAGENT_REDMINE_URL` / `_PROJECT` / `_ISSUE` 三个变量。

## 5. 配置并观察首次轮询

1. 填 `baseUrl`（如 `http://redmine.example.com`）与 `projectId`（identifier 或数字 id），保存；
2. 首次轮询会依次校验：`GET /users/current.json`（账号）、`GET /projects/<projectId>.json`（项目可见性，
   并把 identifier 解析成数字 id）；失败会写 `error` 健康条目并说明原因，不会产生工单；
3. 成功后卡片显示 **Connected as &lt;login&gt;** 与项目名（facts），健康变 `ready`，详情里有本轮读到的 issue 数与
   收到的 Trigger 数；
4. 在 Redmine 新建一个带 `@dsh` 的 issue，≤ 2 个轮询周期内应出现 Ticket；
5. Policy 里加入该用户的**数字 user id**（个人资料页地址 `/users/<id>`），否则只会得到「名单外」丢弃原因。

## 6. 上线前只读探测（推荐）

```sh
export REDMINE_URL=http://redmine.example.com
export REDMINE_API_KEY=...
export REDMINE_PROJECT=my-project
./scripts/probe-redmine.sh
```

它只发 GET：确认账号、项目可见性、issue 可见数、时间戳过滤能力（2.3 返回 422 属预期）、真实时间格式、
journals/attachments 结构、`content_url`、`?key=` 兜底。**不要**用它写任何 issue。

## 7. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 卡片一直是 `paused`，detail 为 "Waiting for the deployment check" | dsh-superagent 自身 setup 未完成（它只认 GitHub 仓库 + agent CLI）；先完成它的 setup |
| `error`：`The environment variable REDMINE_API_KEY is empty or unset` | Key 对 DSH 进程不可见；见 §3 |
| `error`：`Redmine responded 401` | Key 无效/已过期；确认账号能登录 Redmine |
| `error`：`Redmine responded 404`（项目） | 项目 identifier 写错，或账号对该项目不可见（2.3 对不可见项目返回 401/404） |
| `ready` 但 0 条 issue、且项目确有 issue | 账号角色缺「查看问题」权限；这是 2.3 的已知行为（带 `project_id` 的请求不会 403） |
| 图片读不出来 | `/attachments/:id.json` 或下载 403：确认账号能看该 issue 的附件；插件会如实报「图片不可读」，不会让 Eval 失败 |
| 只看到旧评论 / 看不到新评论 | 确认 `overlapSeconds` 与 `pollSeconds`；进程重启后游标从 KV 恢复，不会回填历史。批量导入导致单轮耗时变长时，可临时缩小 `overlapSeconds` / `pollSeconds` |
| 私有评论出现在工单里 | Redmine **2.6–3.3** 有私有备注但 API 不返回 `private_notes`，插件无法识别；3.4+ 会在 Trigger 与 Eval 上下文里都跳过。升级，或约定不把私有备注当请求 |
| 无法访问 Redmine | 目标实例是 HTTP：Key 明文传输，只应在内网/VPN 使用；有条件时在反向代理终止 TLS |
| 反向代理剥掉 `X-Redmine-API-Key` | 插件在 401 后自动改用 `?key=` 并缓存该模式（首次成功请求后会一直用它） |

## 8. 卸载

```sh
dsh plugin --profile superagent remove dsh-superagent-redmine
```

并删除 `cordis.patch.yml` 里对应的 `insert` 项。已产生的 Trigger/Ticket 与 Redmine 评论都不会被删除。
