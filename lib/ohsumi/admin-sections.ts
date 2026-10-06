// 管理画面(ADMIN)のタブの並び・グループと、役職ごとの「見られるタブ」(roles の sections)の引き継ぎ。
//
// タブを作り直した時(状況・仕事・人と組織・育成・申請と記録・設定)に、以前のタブを分けた・まとめたので、
// 保存されている以前のキーは、新しいキーに読み替える(分けたタブは、分かれた先をすべて許可する):
//   leadership(幹部 View) → dashboard(ホーム)・orgRoles(後継者・候補者の提案)
//   tags                  → taskSettings・orgRoles・memberdb・skillRules・oneOnOneSurvey・orgSettings
//   org(Org Tree)         → orgRoles
//   radar(レーダー)        → analytics(チームレーダー)・skillRules(軸の設定)
//   projects              → projects・taskSettings(プロジェクトの種類・業務テンプレート・定期タスク・ゴミ箱)
// 新しい形で保存した一覧には SECTIONS_FORMAT_MARKER を入れ、読み替えない(projects だけを選んだ役職に
// taskSettings を足し直さないように)。GAS は expenses・forms だけを見るので、この印は無視される
import { ADMIN_SECTIONS, type AdminSection } from './types'

export const SECTIONS_FORMAT_MARKER = 'v2'

export const LEGACY_SECTION_MAP: Record<string, AdminSection[]> = {
  leadership: ['dashboard', 'orgRoles'],
  tags: ['taskSettings', 'orgRoles', 'memberdb', 'skillRules', 'oneOnOneSurvey', 'orgSettings'],
  org: ['orgRoles'],
  radar: ['analytics', 'skillRules'],
  projects: ['projects', 'taskSettings'],
}

const KNOWN = new Set<string>(ADMIN_SECTIONS.map((s) => s.key))

/** 保存されている一覧を、今のタブのキーにする(知らないキーは捨てる。並びは ADMIN_SECTIONS の順) */
export function migrateAdminSections(list: readonly string[]): AdminSection[] {
  const current = list.includes(SECTIONS_FORMAT_MARKER)
  const out = new Set<string>()
  for (const key of list) {
    if (key === SECTIONS_FORMAT_MARKER) continue
    const mapped = !current && LEGACY_SECTION_MAP[key] ? LEGACY_SECTION_MAP[key] : [key]
    for (const k of mapped) if (KNOWN.has(k)) out.add(k)
  }
  return ADMIN_SECTIONS.map((s) => s.key).filter((k) => out.has(k))
}

/** 保存する一覧(新しい形の印を付ける) */
export function sectionsForSave(list: readonly AdminSection[]): string[] {
  return [...migrateAdminSections([...list, SECTIONS_FORMAT_MARKER]), SECTIONS_FORMAT_MARKER]
}

export type AdminGroupKey = 'status' | 'work' | 'people' | 'growth' | 'records' | 'settings'

// メニューの並び(パソコンの左のメニューのグループと、スマートフォンの上のタブ)
export const ADMIN_GROUPS: { key: AdminGroupKey; sections: AdminSection[] }[] = [
  { key: 'status', sections: ['dashboard', 'analytics'] },
  { key: 'work', sections: ['approvals', 'assignments', 'projects', 'taskSettings'] },
  { key: 'people', sections: ['members', 'orgRoles', 'memberdb', 'recruiting'] },
  { key: 'growth', sections: ['skillRules', 'quiz', 'learning', 'oneOnOneSurvey'] },
  { key: 'records', sections: ['expenses', 'forms', 'dailyReports'] },
  { key: 'settings', sections: ['orgSettings'] },
]
