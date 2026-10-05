// setupOhsumi が入れる役職・選択肢の初期値: 新しい団体はどの団体にも当てはまる値、すでに動いている団体は今の画面の値を保存する。
// 要求分野(skill_field_options)と分野ごとのスキル(skill_field_skills)も同じ。すでにある設定は上書きしない
import { describe, expect, it } from 'vitest'
import { createWorld } from './e2e/world'

const settings = (rows: unknown[][]) => Object.fromEntries(rows.slice(1).map((r) => [String(r[0]), String(r[1])]))

describe('setupOhsumi の初期値', () => {
  it('新しい団体: 要求分野と分野ごとのスキルは、どの団体にも当てはまる値(スキルは選択肢の中から)', () => {
    const w = createWorld()
    const { org } = w.launchOrg('団体A', 'contact@a.example')
    const s = settings(org.sheets.Settings.rows)
    const fields = s.skill_field_options.split(',')
    expect(fields).toEqual(['企画', 'デザイン', '広報', '運営', 'データ・開発'])
    const skills = JSON.parse(s.skill_field_skills) as Record<string, string[]>
    expect(Object.keys(skills)).toEqual(fields)
    const pool = new Set(s.skill_options.split(','))
    for (const list of Object.values(skills)) for (const k of list) expect(pool.has(k), k).toBe(true)
    expect(s.skill_field_options).not.toContain('AI活用')
  })

  it('すでに動いている団体: 今の画面の値を保存し、ある設定は上書きしない', () => {
    const w = createWorld()
    const { org } = w.launchOrg('団体B', 'contact@b.example')
    const rows = org.sheets.Settings.rows
    // 要求分野だけ消して(以前の版の団体と同じ)、メンバーがいる状態で setupOhsumi をもう一度実行する
    org.sheets.Settings.rows = rows.filter((r) => !['skill_field_options', 'skill_field_skills', 'skill_options'].includes(String(r[0])))
    org.sheets.Settings.rows.push(['skill_options', '独自のスキル'])
    const mh = org.sheets.Members.rows[0]
    org.sheets.Members.rows.push(mh.map((h) => (h === 'id' ? '1' : h === 'name' ? '代表' : '')))
    ;(org.gas.setupOhsumi as () => void)()
    const s = settings(org.sheets.Settings.rows)
    expect(s.skill_field_options).toBe('デザイン,営業,AI活用')
    expect(s.skill_field_skills).toBe('{}')
    expect(s.skill_options).toBe('独自のスキル')
  })
})
