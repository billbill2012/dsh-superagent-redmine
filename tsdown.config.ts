import { defineConfig } from 'tsdown'

// One entry only: the plugin is loaded by dsh-superagent in-process. Type-only imports from `@deepseek-ai/*`
// never produce runtime imports, so the built file depends on Node built-ins and `zod` alone.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod'] },
})
