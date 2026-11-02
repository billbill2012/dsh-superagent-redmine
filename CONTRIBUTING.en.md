# Contributing

[中文](CONTRIBUTING.md) | **English**

Thanks for helping improve `dsh-superagent-redmine`. This is a small plugin: **readability, tests, and minimal dependencies** matter more than feature count.

## Development setup

- Node.js ≥ 22.19 or ≥ 24
- pnpm 11 (`packageManager` is pinned to `pnpm@11.7.0`)
- A writable Redmine instance for manual checks (recommended: `docker run -p 3000:3000 redmine:6.1`). **Do not write-test against production.**

```sh
pnpm install
pnpm check        # typecheck + vitest + tsdown
```

> `dsh-superagent` is a private package. It is listed as an optional peer; `pnpm-workspace.yaml` disables `autoInstallPeers`, so `pnpm install` will not fetch it from npm. The host process loads the plugin at runtime.

## Code style

- TypeScript strict with `noUncheckedIndexedAccess`; local imports keep the `.ts` suffix (e.g. `from './client.ts'`).
- House style: 2-space indent, single quotes, **no semicolons**, comments explain *why*; exported APIs have JSDoc.
- UI copy is bilingual `Localized` (zh/en). Health `detail` strings stay in English (matching the host’s built-in health templates).
- Do not add runtime dependencies. Do not `import` dsh-superagent runtime modules (`import type` only—zero runtime coupling).

## Tests

- New or changed behavior needs tests; when local design docs are available, prefer aligning with the C/T/K ids in the monorepo file `docs/dsh-superagent-redmine/04-测试计划.md`.
- Use the scripted `fetch` in `tests/helpers/fetch.ts`—no network, no wall clock. Inject `now` for time-sensitive cases.
- Live Redmine checks are local manual work; never commit instance URLs or keys.

## Commits and pull requests

- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:` (scopes OK, e.g. `fix(poll): ...`).
- One concern per PR; open an issue first for larger changes.
- Before merge: `pnpm check` passes, new tests cover the change, docs are updated.
- Do not commit `node_modules/`, `lib/`, API keys, or screenshots that contain secrets.

## Security

Read [SECURITY.en.md](SECURITY.en.md). **Never put credentials in issues, PRs, logs, or fixtures.**

## Code of Conduct

By participating, you agree to uphold the [.github/CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) (Contributor Covenant).

## License

This project is [MIT](LICENSE). By contributing, you agree your contribution is released under MIT.
