# 贡献指南

**中文** | [English](CONTRIBUTING.en.md)

感谢你愿意改进 `dsh-superagent-redmine`。这是一个小体量插件，保持它**可读、可测、最小依赖**比增加功能更重要。

## 开发环境

- Node.js ≥ 22.19 或 ≥ 24
- pnpm 11（`packageManager` 已固定为 `pnpm@11.7.0`）
- 一台可写的 Redmine 实例（推荐 Docker：`docker run -p 3000:3000 redmine:6.1`），**不要用生产实例做写测试**

```sh
pnpm install
pnpm check        # typecheck + vitest + tsdown
```

> `dsh-superagent` 是私有包，`package.json` 里只是可选 peer，`pnpm-workspace.yaml` 关闭了 `autoInstallPeers`，
> 所以 `pnpm install` 不会去 npm 拉它。插件运行时由宿主进程加载。

## 代码约定

- TypeScript strict + `noUncheckedIndexedAccess`；本地 import 带 `.ts` 后缀（例如 `from './client.ts'`）。
- 仓库风格：2 空格缩进、单引号、**不写分号**、注释解释「为什么」而不是复述代码；导出的 API 有 JSDoc。
- UI 文案用中英双语 `Localized`；健康详情的 `detail` 用英文（与宿主内置健康模板一致）。
- 不新增运行时依赖；不 `import` dsh-superagent 的运行时模块（只用 `import type`，保持零运行时耦合）。

## 测试

- 新增/修改行为必须带测试；若本地有设计文档，尽量对应 monorepo `docs/dsh-superagent-redmine/04-测试计划.md` 的 C/T/K 编号。
- 测试用 `tests/helpers/fetch.ts` 的脚本化 `fetch`，不触网、不依赖时钟；时间相关用注入的 `now`。
- 针对真实 Redmine 的验证属于本地手工测试，不要把实例地址/Key 写进仓库。

## 提交与 PR

- 提交信息用 Conventional Commits：`feat:`, `fix:`, `docs:`, `test:`, `chore:`（可带 scope，如 `fix(poll): ...`）。
- 一个 PR 聚焦一件事；请先开 issue 讨论较大的改动。
- PR 合并前必须：`pnpm check` 通过、新增测试覆盖改动、文档同步更新。
- 不要提交 `node_modules/`、`lib/`、任何 API Key 或含密钥的截图。

## 安全

请阅读 [SECURITY.md](SECURITY.md)。**任何凭据都不要出现在 issue、PR、日志或测试夹具里。**

## 行为准则

参与本项目即表示你同意遵守 [.github/CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md)（Contributor Covenant）。

## 许可

本项目使用 [MIT](LICENSE)。提交贡献即表示你同意以 MIT 协议发布你的贡献。
