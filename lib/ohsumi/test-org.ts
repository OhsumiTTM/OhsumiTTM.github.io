// テスト用: レジストリがある環境で、招待リンクから団体を使い始めた後の状態にする
// (ビルド時の「既定の団体」は無いので、GAS に送るテストは、この団体を使う)。
// vi.resetModules() の後、remote.ts などを読み込む前に呼ぶ
import { vi } from 'vitest'

export const TEST_REGISTRY_URL = 'https://script.google.com/macros/s/TEST_REGISTRY/exec'
export const TEST_ORG_ID = 'org_TESTTESTTESTTEST01'

export async function useTestOrg(gasUrl: string, orgId = TEST_ORG_ID): Promise<void> {
  vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', TEST_REGISTRY_URL)
  const d = await import('./org-directory')
  d.activateOrg({ orgId, gasUrl, source: 'registry', checkedAt: Date.now() })
}
