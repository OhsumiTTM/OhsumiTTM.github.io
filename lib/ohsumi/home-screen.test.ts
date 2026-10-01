// ホーム画面に追加したアイコン・ブックマークに、団体(?org=)が残ること。
// アドレスバーは、いつも今の団体の /?org=<団体ID> にしている(org-directory.ts の syncOrgParam。check:layout でも確かめる)。
// ウェブアプリの設定(manifest)の start_url があると、ホーム画面のアイコンはアドレスバーではなく start_url を開くため、
// 団体が消える。manifest を足す時は、start_url を付けない(アドレスバーの URL を使わせる)こと
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { googleCalendarUrl } from './utils'

const ROOT = join(__dirname, '..', '..')

describe('ホーム画面に追加しても団体が残る', () => {
  it('manifest で start_url を決めていない(ホーム画面のアイコンは、アドレスバーの /?org=<団体ID> を開く)', () => {
    const manifests = readdirSync(join(ROOT, 'public')).filter((f) => /manifest/i.test(f))
    for (const f of manifests) expect(JSON.parse(readFileSync(join(ROOT, 'public', f), 'utf8')).start_url, f).toBeUndefined()
    for (const f of ['app/manifest.ts', 'app/manifest.json', 'app/manifest.webmanifest']) {
      if (existsSync(join(ROOT, f))) expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/start_url/)
    }
  })
})

describe('カレンダーの予定からサイトを開ける', () => {
  it('予定の説明に、今の団体の招待リンクを入れる', () => {
    const url = googleCalendarUrl({ name: 'T', deadline: '2026-10-20' } as Parameters<typeof googleCalendarUrl>[0], { appLink: 'https://site.example/?org=org_ABCDEFGHIJKLMNOP' })!
    expect(new URL(url).searchParams.get('details')).toContain('Ohsumiから追加: https://site.example/?org=org_ABCDEFGHIJKLMNOP')
  })
})
