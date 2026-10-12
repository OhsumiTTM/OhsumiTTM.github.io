// 代表の管理画面の「GAS の更新が要ります」の「コードをコピー」(components/ohsumi/admin/gas-update-banner.tsx)と、
// レジストリの管理画面の「新しい団体に渡すもの」。
// サイトの /gas/<版>/Code.gs(ビルドの時に gas/releases/<版>/ から置く。scripts/gas-build.mjs)を同じサイトから読み、
// その団体のプランで配っている版と同じ版のコードだけをクリップボードに入れる(CSP は connect-src 'self' のまま)。
// /gas/Code.gs は一番新しい版(ほかの用途のために残す)
export const SITE_GAS_CODE_PATH = '/gas/Code.gs'

/** その版のコードのサイトの場所。版の形(YYYY.MM.DD-N)でなければ null */
export function siteGasCodePath(version: string): string | null {
  return /^\d{4}\.\d{2}\.\d{2}-\d+$/.test(version) ? `/gas/${version}/Code.gs` : null
}

/** コードの版(var OHSUMI_GAS_VERSION = '…' の行)。見つからなければ null */
export function gasCodeVersion(code: string): string | null {
  const m = /^var OHSUMI_GAS_VERSION = '([^']*)'$/m.exec(code)
  return m ? m[1] : null
}

export type GasCodeCheck =
  | { ok: true; version: string }
  | { ok: false; reason: 'notGas' | 'mismatch'; version: string | null }

/** 読んだコードが、配っている版と同じか */
export function checkGasCode(code: string, latest: string): GasCodeCheck {
  const version = gasCodeVersion(code)
  if (!version || !/function doPost\(/.test(code)) return { ok: false, reason: 'notGas', version }
  if (version !== latest) return { ok: false, reason: 'mismatch', version }
  return { ok: true, version }
}

/** サイトの /gas/<版>/Code.gs を読み、その版ならクリップボードに入れる */
export async function copySiteGasCode(
  latest: string,
  deps: { fetch?: typeof fetch; writeText?: (text: string) => Promise<void> } = {},
): Promise<GasCodeCheck | { ok: false; reason: 'fetch' | 'clipboard'; version: string | null }> {
  const doFetch = deps.fetch ?? fetch
  const path = siteGasCodePath(latest)
  if (!path) return { ok: false, reason: 'fetch', version: null }
  let code = ''
  try {
    const res = await doFetch(path, { cache: 'no-store' })
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

/** 版の一覧のうち一番新しい版(「YYYY.MM.DD-N」を日付・番号の順に比べる。日付の形でない版は数えない) */
export function newestGasVersion(versions: readonly string[]): string | null {
  const key = (v: string) => {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(v)
    return m ? Number(m[1] + m[2] + m[3]) * 10000 + Number(m[4]) : null
  }
  let best: string | null = null
  for (const v of versions) {
    const k = key(v)
    if (k !== null && (best === null || k > key(best)!)) best = v
  }
  return best
}
