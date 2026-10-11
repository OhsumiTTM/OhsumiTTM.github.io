// デモの団体: 団体の GAS(gas/Code.gs)を、ブラウザの中の偽のスプレッドシートの上で動かす。
// 初めて開いた時は、新しい団体と同じく setupOhsumi を実行し、見本データ(gas/sample の seedShowcaseData。
// 架空の「つばさ学生会議」)を入れる。日付は開いた日を基準にする。
import type { Cell } from '../ohsumi/gas-fakes'
import { createGoogleEnv, type DemoGasState, type DemoGoogleEnv } from './google-env'

export type DemoGasFactory = (env: Record<string, unknown>) => {
  doPost: (e: { postData: { contents: string } }) => { text: string }
  setupOhsumi: () => void
  seedShowcaseData: () => string
}

export const DEMO_ORG_NAME = 'つばさ学生会議'

// ログインできる枠(gas/sample/30-showcase-data.gs の SHOWCASE_ACCOUNT_SLOTS)と、その枠のメールアドレス。
// example.com のアドレス(実在の人のものではない)
export const DEMO_ACCOUNTS = {
  top: 'aoi.morita@example.com',
  admin: 'takuma.ishii@example.com',
  restricted: 'misaki.okada@example.com',
  base: 'hinata.fujii@example.com',
  base_en: 'lena.fischer@example.com',
} as const
export type DemoSlot = keyof typeof DEMO_ACCOUNTS

export interface DemoOrg {
  post: (body: Record<string, unknown>) => unknown
  state: () => DemoGasState
  google: DemoGoogleEnv
}

export function createDemoOrg(
  factory: DemoGasFactory,
  opts: { gasUrl: string; registryUrl: string; clientId: string; orgId: string; state?: DemoGasState | null },
): DemoOrg {
  const fresh = !opts.state
  const initial: DemoGasState = opts.state ?? {
    name: DEMO_ORG_NAME,
    sheets: {} as Record<string, Cell[][]>,
    props: {
      // 団体ID は決まった値(setupOhsumi は、あれば変えない)
      ORG_ID: opts.orgId,
      GOOGLE_OAUTH_CLIENT_ID: opts.clientId,
      REGISTRY_URL: opts.registryUrl,
      OHSUMI_WEBAPP_URL: opts.gasUrl,
      DEMO_ORG: 'true',
      DEMO_ACCOUNTS: Object.entries(DEMO_ACCOUNTS).map(([k, v]) => `${k}=${v}`).join(','),
    },
    cache: [],
  }
  const google = createGoogleEnv({ gasUrl: opts.gasUrl, clientId: opts.clientId, state: initial })
  const gas = factory(google.env)
  if (fresh) {
    gas.setupOhsumi()
    gas.seedShowcaseData()
  }
  const post = (body: Record<string, unknown>) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text) as unknown
  return { post, state: google.state, google }
}
