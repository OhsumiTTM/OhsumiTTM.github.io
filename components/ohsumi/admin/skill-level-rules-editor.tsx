'use client'

// スキルのレベルの決め方(設定の画面。代表・全権管理者)。lib/ohsumi/skill-levels.ts
//   - 団体の既定: Lv.1〜5 に必要な累計の点数と、レベルごとの条件(何も設定しなければ組み込みの決まり)
//   - スキルごと: そのスキルだけの決まり(使わなければ団体の既定)
// 条件: 関連する資格の件数(外部評価だけを数えることもできる)・検定の合格・完了したタスクの数
// 保存されたレベルは下げない(決め方を変えても、上がった人はそのまま)
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { conditionText } from '@/components/ohsumi/skill-condition-text'
import {
  SKILL_LEVELS,
  levelConditionsFor,
  levelPointsFor,
  validLevelPoints,
  type LevelCondition,
  type SkillLevelRules,
  type SkillRule,
} from '@/lib/ohsumi/skill-levels'

interface Row {
  points: string
  qualMin: string
  qualExternal: boolean
  quiz: boolean
  tasksMin: string
  /** 承認の条件(この画面ではまだ変えられない。保存し直しても消さない) */
  approval?: boolean
}

const DEFAULT_TARGET = '__default__'

function rowsOf(rules: SkillLevelRules, skill: string): Row[] {
  const points = levelPointsFor(rules, skill)
  return SKILL_LEVELS.map((level, i) => {
    const conds = levelConditionsFor(rules, skill, level)
    const qual = conds.find((c) => c.type === 'qualification') as Extract<LevelCondition, { type: 'qualification' }> | undefined
    const tasks = conds.find((c) => c.type === 'tasksDone') as Extract<LevelCondition, { type: 'tasksDone' }> | undefined
    return { points: String(points[i]), qualMin: qual ? String(qual.min) : '', qualExternal: !!qual?.external, quiz: conds.some((c) => c.type === 'quiz'), tasksMin: tasks ? String(tasks.min) : '', approval: conds.some((c) => c.type === 'approval') }
  })
}

/** 入力から決まりを作る。正しくなければエラーの文 */
export function ruleFromRows(rows: Row[]): { rule?: SkillRule; error?: string } {
  const points = rows.map((r) => Number(r.points.trim()))
  if (!validLevelPoints(points)) return { error: 'points' }
  const conditions: NonNullable<SkillRule['conditions']> = {}
  for (let i = 0; i < 5; i++) {
    const r = rows[i]
    const list: LevelCondition[] = []
    const intOf = (v: string) => (v.trim() ? Number(v.trim()) : null)
    const qm = intOf(r.qualMin)
    if (qm !== null) {
      if (!Number.isInteger(qm) || qm < 1 || qm > 1000) return { error: 'min' }
      list.push(r.qualExternal ? { type: 'qualification', min: qm, external: true } : { type: 'qualification', min: qm })
    }
    if (r.quiz) list.push({ type: 'quiz' })
    const tm = intOf(r.tasksMin)
    if (tm !== null) {
      if (!Number.isInteger(tm) || tm < 1 || tm > 1000) return { error: 'min' }
      list.push({ type: 'tasksDone', min: tm })
    }
    if (r.approval) list.push({ type: 'approval' })
    conditions[String(i + 1) as '1'] = list
  }
  return { rule: { points, conditions } }
}

export function SkillLevelRulesEditor() {
  const { t } = useI18n()
  const { skillOptions, skillLevelRules, updateSkillLevelRules } = useOhsumi()
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isDefault = target === DEFAULT_TARGET
  const own = isDefault ? skillLevelRules.default : skillLevelRules.skills?.[target]
  // 表示する値: 編集中はその入力、そうでなければ今の決まり(スキルは、団体の既定を引き継いだもの)
  const shown = rows ?? rowsOf(skillLevelRules, isDefault ? '' : target)
  const editing = rows !== null

  const choose = (next: string) => { setTarget(next); setRows(null); setError(null) }
  const save = () => {
    const r = ruleFromRows(shown)
    if (!r.rule) { setError(r.error === 'points' ? t('admin.skillRules.error.points') : t('admin.skillRules.error.min')); return }
    const next: SkillLevelRules = { ...skillLevelRules, skills: { ...(skillLevelRules.skills ?? {}) } }
    if (isDefault) next.default = r.rule
    else next.skills![target] = r.rule
    if (next.skills && !Object.keys(next.skills).length) delete next.skills
    updateSkillLevelRules(next)
    setRows(null)
    setError(null)
  }
  const reset = () => {
    const next: SkillLevelRules = { ...skillLevelRules, skills: { ...(skillLevelRules.skills ?? {}) } }
    if (isDefault) delete next.default
    else delete next.skills![target]
    if (next.skills && !Object.keys(next.skills).length) delete next.skills
    updateSkillLevelRules(next)
    setRows(null)
    setError(null)
  }
  const set = (i: number, patch: Partial<Row>) => setRows(shown.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const field = 'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary disabled:opacity-60'
  const skillsWithRules = Object.keys(skillLevelRules.skills ?? {})

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4" data-skill-level-rules>
      <SectionLabel>{t('admin.skillRules.title')}</SectionLabel>
      <p className="mt-1 text-xs text-muted-foreground">{t('admin.skillRules.desc')}</p>
      <label className="mt-3 block text-xs">
        {t('admin.skillRules.target')}
        <select value={target} onChange={(e) => choose(e.target.value)} className={field + ' mt-1 cursor-pointer'} data-skill-rules-target>
          <option value={DEFAULT_TARGET}>{t('admin.skillRules.target.default')}</option>
          {skillOptions.map((s) => (
            <option key={s} value={s}>{s}{skillsWithRules.includes(s) ? t('admin.skillRules.target.hasOwn') : ''}</option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-muted-foreground" data-skill-rules-source>
        {own ? t(isDefault ? 'admin.skillRules.source.defaultOwn' : 'admin.skillRules.source.skillOwn') : t(isDefault ? 'admin.skillRules.source.builtin' : 'admin.skillRules.source.inherit')}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {shown.map((r, i) => (
          <div key={i} className="rounded-md border border-border/60 p-2 text-xs" data-skill-rule-level={i + 1}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-12 shrink-0 font-medium">Lv.{i + 1}</span>
              <label className="flex min-w-0 flex-1 items-center gap-1">
                <span className="shrink-0">{t('admin.skillRules.points')}</span>
                <input inputMode="numeric" disabled={!editing} className={field} value={r.points} onChange={(e) => set(i, { points: e.target.value })} />
              </label>
            </div>
            {editing ? (
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
                <label className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0">{t('admin.skillRules.qualMin')}</span>
                  <input inputMode="numeric" className={field} value={r.qualMin} placeholder="—" onChange={(e) => set(i, { qualMin: e.target.value })} />
                </label>
                <label className="flex min-w-0 items-center gap-1">
                  <input type="checkbox" checked={r.qualExternal} onChange={(e) => set(i, { qualExternal: e.target.checked })} />
                  <span className="min-w-0 break-words">{t('admin.skillRules.qualExternal')}</span>
                </label>
                <label className="flex min-w-0 items-center gap-1">
                  <input type="checkbox" checked={r.quiz} onChange={(e) => set(i, { quiz: e.target.checked })} />
                  <span className="min-w-0 break-words">{t('admin.skillRules.quiz')}</span>
                </label>
                <label className="flex min-w-0 items-center gap-1 sm:col-span-3">
                  <span className="shrink-0">{t('admin.skillRules.tasksMin')}</span>
                  <input inputMode="numeric" className={field} value={r.tasksMin} placeholder="—" onChange={(e) => set(i, { tasksMin: e.target.value })} />
                </label>
              </div>
            ) : (
              <p className="mt-1 break-words text-muted-foreground">
                {(() => {
                  const rule = ruleFromRows(shown).rule
                  const conds = rule?.conditions?.[String(i + 1) as '1'] ?? []
                  return conds.length ? conds.map((c) => conditionText(c, t)).join('・') : t('admin.skillRules.noConditions')
                })()}
              </p>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" onClick={save}>{t('common.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setRows(null); setError(null) }}>{t('common.cancel')}</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setRows(shown)}>{t(isDefault ? 'admin.skillRules.editDefault' : 'admin.skillRules.editSkill')}</Button>
        )}
        {!editing && own && (
          <Button size="sm" variant="ghost" onClick={reset}>{t(isDefault ? 'admin.skillRules.resetDefault' : 'admin.skillRules.resetSkill')}</Button>
        )}
      </div>
    </div>
  )
}
