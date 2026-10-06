// 管理画面のタブを作り直した時の「見られるタブ」の引き継ぎ: 以前のキーは新しいキーに読み替え、分けたタブはすべて許可する。
// 新しい形で保存した一覧は読み替えない。expenses・forms は GAS が使うので、そのまま残す
import { describe, expect, it } from 'vitest'
import { ADMIN_GROUPS, LEGACY_SECTION_MAP, SECTIONS_FORMAT_MARKER, migrateAdminSections, sectionsForSave } from './admin-sections'
import { ADMIN_SECTIONS } from './types'
import { resolveVisibleAdminSections } from './permissions'
import type { RoleDef } from './roles'

describe('見られるタブの引き継ぎ', () => {
  it('以前のキーを、分かれた先のタブすべてに読み替える', () => {
    expect(migrateAdminSections(['tags'])).toEqual(['taskSettings', 'orgRoles', 'memberdb', 'skillRules', 'oneOnOneSurvey', 'orgSettings'])
    expect(migrateAdminSections(['leadership'])).toEqual(['dashboard', 'orgRoles'])
    expect(migrateAdminSections(['org'])).toEqual(['orgRoles'])
    expect(migrateAdminSections(['radar'])).toEqual(['analytics', 'skillRules'])
    expect(migrateAdminSections(['projects'])).toEqual(['projects', 'taskSettings'])
    expect(migrateAdminSections(['approvals', 'expenses', 'forms', 'quiz', 'unknown'])).toEqual(['approvals', 'quiz', 'expenses', 'forms'])
  })

  it('新しい形で保存した一覧は読み替えない。保存する時は印を付け、expenses・forms はそのまま残す', () => {
    expect(migrateAdminSections(['projects', SECTIONS_FORMAT_MARKER])).toEqual(['projects'])
    const saved = sectionsForSave(['projects', 'expenses', 'forms'])
    expect(saved).toEqual(['projects', 'expenses', 'forms', SECTIONS_FORMAT_MARKER])
    expect(migrateAdminSections(saved)).toEqual(['projects', 'expenses', 'forms'])
  })

  it('役職の見られるタブにも効く(以前のキーで保存した役職)', () => {
    const roles: RoleDef[] = [
      { id: 'base', name: '一般', tier: 'base' },
      { id: 'r1', name: '班長', tier: 'admin', restricted: true, sections: ['tags', 'expenses'] as never },
      { id: 'r2', name: '新', tier: 'admin', restricted: true, sections: ['projects', SECTIONS_FORMAT_MARKER] as never },
      { id: 'top', name: '代表', tier: 'top' },
    ]
    expect(resolveVisibleAdminSections(roles, 'r1')).toEqual(['dashboard', 'taskSettings', 'orgRoles', 'memberdb', 'skillRules', 'oneOnOneSurvey', 'expenses', 'orgSettings'])
    expect(resolveVisibleAdminSections(roles, 'r2')).toEqual(['dashboard', 'projects'])
  })

  it('メニューのグループに、すべてのタブ(と採用)が1回ずつある。読み替え先はすべて今のタブ', () => {
    const inGroups = ADMIN_GROUPS.flatMap((g) => g.sections)
    expect(new Set(inGroups).size).toBe(inGroups.length)
    expect(inGroups.filter((k) => k !== 'recruiting').sort()).toEqual(ADMIN_SECTIONS.map((s) => s.key).sort())
    const known = new Set(ADMIN_SECTIONS.map((s) => s.key))
    for (const list of Object.values(LEGACY_SECTION_MAP)) for (const k of list) expect(known.has(k), k).toBe(true)
  })
})
