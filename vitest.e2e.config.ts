// 公開前の通しテストの画面(ブラウザ)の部分。pnpm test:e2e で動かす(ふだんの pnpm test には入れない)
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
