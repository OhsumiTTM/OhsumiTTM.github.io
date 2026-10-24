// プランに配っている団体の GAS の版に合わせた画面(版の画面)。
//
// サイトには、いつもの画面(main。/ に置く)のほかに、配っている版ごとの画面を /_v/<版>/ に置く
// (scripts/build-site-versions.mjs。部品だけを /_v/<版>/ から読み、URL の形は今と同じ)。置いた版は /_v/index.json に書く。
// 団体がどの版の画面を使うかは、レジストリが resolveOrg の siteVersion で答える(registry/Code.gs の siteVersionFor_):
//   一番新しい配る版のプラン・FSIF(internal)・デモの団体は ''(main の画面)、それ以外はそのプランの配る版。
// リンクは変えない: 版の画面に移った直後に、アドレスバーを /?org=…&task=… に戻す(app/layout.tsx の最初のスクリプト)。
// 版の画面が置かれていない時(この仕組みより前の版・作れなかった版)は、main の画面のまま使う。
//
// 端末に覚えるもの(org-directory.ts の SavedOrg):
//   siteVersion: レジストリの答え / screen: 移る先の版(/_v/index.json にあると確かめた版。最初のスクリプトはこれだけを見る)

/** このビルドの版('' は main の画面) */
export const SITE_VERSION = process.env.NEXT_PUBLIC_SITE_VERSION || ''
export const SITE_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/
export const SITE_VERSIONS_DIR = '/_v/'
export const SITE_VERSIONS_MANIFEST = '/_v/index.json'
const HOPS_KEY = 'ohsumi-site-hops'
const HOP_WINDOW_MS = 60_000
const HOP_LIMIT = 3

export function siteVersionPath(version: string): string {
  return SITE_VERSIONS_DIR + version + '/'
}

/** レジストリの答えの siteVersion(形の違う値は '') */
export function cleanSiteVersion(v: unknown): string {
  return typeof v === 'string' && SITE_VERSION_PATTERN.test(v) ? v : ''
}

/** /_v/index.json の中身(置いた版の一覧)。読めない時は null */
export function parseManifest(raw: unknown): string[] | null {
  const list = (raw as { versions?: unknown } | null)?.versions
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && SITE_VERSION_PATTERN.test(v)) : null
}

export type SiteDecision =
  // このままでよい(screen: 覚え直す移る先)
  | { kind: 'stay'; screen: string }
  // 版の画面に移る
  | { kind: 'version'; version: string }
  // main の画面に戻る
  | { kind: 'main' }

/**
 * どの画面を使うかを決める(純粋な関数)。
 * wanted: レジストリの答え / current: このビルドの版 / available: 置いた版の一覧(読めなかった時は null)
 */
export function decideSite(wanted: string, current: string, available: string[] | null): SiteDecision {
  if (wanted === current) return { kind: 'stay', screen: wanted }
  if (wanted) {
    // 一覧が読めない時は、移らない(今の画面で使い続ける。次に開いた時に確かめ直す)
    if (available === null) return { kind: 'stay', screen: current }
    if (available.includes(wanted)) return { kind: 'version', version: wanted }
  }
  // 版の画面が無い・main の画面を使う団体: 版の画面にいる時だけ main に戻る
  return current ? { kind: 'main' } : { kind: 'stay', screen: '' }
}

/** 移った回数の上限の中か(同じ所を行ったり来たりしないように。このタブで1分に3回まで) */
export function takeHop(now: number = Date.now()): boolean {
  try {
    const s = window.sessionStorage
    const prev = JSON.parse(s.getItem(HOPS_KEY) || 'null') as { n?: number; at?: number } | null
    const fresh = prev && typeof prev.at === 'number' && now - prev.at < HOP_WINDOW_MS
    const n = fresh ? Number(prev!.n) || 0 : 0
    if (n >= HOP_LIMIT) return false
    s.setItem(HOPS_KEY, JSON.stringify({ n: n + 1, at: fresh ? prev!.at : now }))
    return true
  } catch {
    return false
  }
}

/** 移る先の URL(?org= と &task= などは、そのまま付ける) */
export function hopUrl(decision: SiteDecision, search: string, hash: string): string | null {
  if (decision.kind === 'version') return siteVersionPath(decision.version) + search + hash
  if (decision.kind === 'main') return '/' + search + hash
  return null
}

let manifestCache: Promise<string[] | null> | null = null

/** /_v/index.json を読む(このページで1回) */
export function loadManifest(fetcher: typeof fetch = fetch): Promise<string[] | null> {
  if (!manifestCache) {
    manifestCache = fetcher(SITE_VERSIONS_MANIFEST, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then(parseManifest)
      .catch(() => null)
  }
  return manifestCache
}

export function resetManifestCacheForTest(): void {
  manifestCache = null
}
