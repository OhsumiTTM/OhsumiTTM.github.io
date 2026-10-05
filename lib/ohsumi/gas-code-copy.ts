// 代表の管理画面の「GAS の更新が要ります」の「コードをコピー」(components/ohsumi/admin/gas-update-banner.tsx)。
// サイトの /gas/Code.gs(ビルドの時に置く。scripts/gas-build.mjs)を同じサイトから読み、知らせに出ている
// 最新の版と同じ版のコードだけをクリップボードに入れる(CSP は connect-src 'self' のまま)
export const SITE_GAS_CODE_PATH = '/gas/Code.gs'

/** コードの版(var OHSUMI_GAS_VERSION = '…' の行)。見つからなければ null */
export function gasCodeVersion(code: string): string | null {
  const m = /^var OHSUMI_GAS_VERSION = '([^']*)'$/m.exec(code)
  return m ? m[1] : null
}

export type GasCodeCheck =
  | { ok: true; version: string }
  | { ok: false; reason: 'notGas' | 'mismatch'; version: string | null }

/** 読んだコードが、知らせに出ている最新の版と同じか */
export function checkGasCode(code: string, latest: string): GasCodeCheck {
  const version = gasCodeVersion(code)
  if (!version || !/function doPost\(/.test(code)) return { ok: false, reason: 'notGas', version }
  if (version !== latest) return { ok: false, reason: 'mismatch', version }
  return { ok: true, version }
}

/** サイトの Code.gs を読み、最新の版と同じならクリップボードに入れる */
export async function copySiteGasCode(
  latest: string,
  deps: { fetch?: typeof fetch; writeText?: (text: string) => Promise<void> } = {},
): Promise<GasCodeCheck | { ok: false; reason: 'fetch' | 'clipboard'; version: string | null }> {
  const doFetch = deps.fetch ?? fetch
  let code = ''
  try {
    const res = await doFetch(SITE_GAS_CODE_PATH, { cache: 'no-store' })
    if (!res.ok) return { ok: false, reason: 'fetch', version: null }
    code = await res.text()
  } catch {
    return { ok: false, reason: 'fetch', version: null }
  }
  const check = checkGasCode(code, latest)
  if (!check.ok) return check
  try {
    await (deps.writeText ?? ((t: string) => navigator.clipboard.writeText(t)))(code)
  } catch {
    return { ok: false, reason: 'clipboard', version: check.version }
  }
  return check
}
