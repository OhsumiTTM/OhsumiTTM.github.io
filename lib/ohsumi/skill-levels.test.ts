// スキルのレベルの決め方(PR Z)
//   - 何も設定しなければ、これまでの画面の計算(50/150/350/550/750 と、資格で Lv.4・5)と同じ結果になる
//   - 画面(lib/ohsumi/skill-levels.ts)と GAS(gas/Code.gs の skillLevelOf_)が、同じ入力で同じ結果になる
//   - 保存されたレベルは下がらない(以前の GAS の計算で上がった人も、そのまま)
//   - 保存されたレベルが新しい計算より高い人も、次のレベルまでの進み具合が負・おかしな値にならない
//   - 点数の一覧(団体の既定・スキルごと)と条件(資格・検定の合格・完了したタスクの数)
import { beforeAll, describe, expect, it } from 'vitest'
import type { Qualification, SkillLevelValue } from './types'
import {
  EMPTY_EVIDENCE,
  levelProgress,
  parseSkillLevelRules,
  skillLevelOf,
  type SkillEvidence,
  type SkillLevelRules,
} from './skill-levels'
import { guardHarness } from './gas-guard-harness'
import { createWorld, type Org, type World } from './e2e/world'

// これまでの画面の計算(PR Z の前の utils.ts の computeSkillLevel を、そのまま写したもの)
function oldScreenLevel(points: number, skill: string, qualifications: Qualification[]): SkillLevelValue | undefined {
  const T = { 1: 50, 2: 150, 3: 350, 4: 550, 5: 750 }
  const related = qualifications.filter((q) => q.relatedSkills?.includes(skill))
  const externalCount = related.filter((q) => q.external).length
  if (points >= T[5] && externalCount >= 3) return 5
  if (points >= T[4] && related.length >= 1) return 4
  if (points >= T[3]) return 3
  if (points >= T[2]) return 2
  if (points >= T[1]) return 1
  return undefined
}

const qual = (skill: string, external: boolean, i: number): Qualification => ({ id: 'q' + i, name: '資格' + i, relatedSkills: [skill], external })
const quals = (skill: string, related: number, external: number): Qualification[] => [
  ...Array.from({ length: related - external }, (_, i) => qual(skill, false, i)),
  ...Array.from({ length: external }, (_, i) => qual(skill, true, 100 + i)),
  // ほかのスキルの資格は数えない
  qual('ほかのスキル', true, 900),
]
const ev = (over: Partial<SkillEvidence> = {}): SkillEvidence => ({ ...EMPTY_EVIDENCE, ...over })

describe('何も設定しない時は、これまでの画面の計算と同じ', () => {
  it('点数 0〜1000 と、関連する資格・外部評価の資格の件数のすべての組み合わせで同じレベルになる', () => {
    let checked = 0
    for (let points = 0; points <= 1000; points++) {
      for (let related = 0; related <= 4; related++) {
        for (let external = 0; external <= related; external++) {
          const q = quals('デザイン', related, external)
          expect(skillLevelOf(points, 'デザイン', ev({ qualifications: q })), `${points}点・資格${related}(外部${external})`).toBe(oldScreenLevel(points, 'デザイン', q))
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(15000)
  })
})

// GAS の計算(本物の gas/Code.gs を動かす)
type Gas = Record<string, (...a: unknown[]) => unknown>
let gas: Gas
beforeAll(() => { gas = guardHarness().c as unknown as Gas })
const gasLevel = (points: number, skill: string, e: SkillEvidence, rules: SkillLevelRules) =>
  (gas.skillLevelOf_(points, skill, JSON.parse(JSON.stringify(e)), JSON.parse(JSON.stringify(rules))) as number) || undefined

describe('画面と GAS が同じ結果になる', () => {
  const RULES: SkillLevelRules[] = [
    {},
    { default: { points: [10, 20, 30, 40, 50] } },
    { default: { conditions: { '2': [{ type: 'quiz' }], '4': [], '5': [{ type: 'tasksDone', min: 3 }] } } },
    { skills: { デザイン: { points: [0, 100, 200, 300, 400], conditions: { '3': [{ type: 'qualification', min: 2, external: true }, { type: 'quiz' }] } } } },
    { default: { points: [5, 15, 35, 55, 75], conditions: { '1': [{ type: 'tasksDone', min: 1 }] } }, skills: { デザイン: { conditions: { '5': [] } } } },
  ]
  it('いろいろな決まり・点数・記録の組み合わせで、レベルが一致する', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    for (const rules of RULES) {
      const parsed = parseSkillLevelRules(JSON.stringify(rules))
      expect(gas.parseSkillLevelRules_(JSON.stringify(rules))).toEqual(JSON.parse(JSON.stringify(parsed)))
      for (let i = 0; i < 600; i++) {
        const skill = rnd(3) ? 'デザイン' : '企画'
        const related = rnd(5)
        const e = ev({
          qualifications: quals(skill, related, rnd(related + 1)),
          quizPasses: rnd(2) ? [{ quizId: 'qz', skill, level: (1 + rnd(5)) as SkillLevelValue, at: '2026-10-01' }] : [],
          doneTaskCounts: { [skill]: rnd(5) },
        })
        const points = rnd(900)
        expect(gasLevel(points, skill, e, parsed), JSON.stringify({ rules, points, e })).toBe(skillLevelOf(points, skill, e, parsed))
      }
    }
  })

  it('壊れた設定は、使える部分だけを読む(画面と GAS で同じ)', () => {
    const raw = { default: { points: [100, 50, 10, 1, 0] }, skills: { デザイン: { points: [1, 2, 3, 4, 5], conditions: { '2': [{ type: 'unknown' }, { type: 'tasksDone', min: 0 }, { type: 'quiz' }] } }, '': { points: [1, 2, 3, 4, 5] } } }
    const parsed = parseSkillLevelRules(JSON.stringify(raw))
    expect(parsed).toEqual({ skills: { デザイン: { points: [1, 2, 3, 4, 5], conditions: { '2': [{ type: 'quiz' }] } } } })
    expect(gas.parseSkillLevelRules_(JSON.stringify(raw))).toEqual(JSON.parse(JSON.stringify(parsed)))
    expect(parseSkillLevelRules('{壊れた')).toEqual({})
  })
})

describe('保存されたレベルは下がらない', () => {
  it('以前の GAS の計算で上がった人(100点で Lv.2 など)は、点数を足しても、そのままか上がるだけ', () => {
    const current = [{ skill: 'デザイン', level: 2, acquiredAt: '2026-01-01' }, { skill: '企画', level: 5 }, { skill: '手を付けていない', level: 1 }]
    const out = gas.computeAutoLevels_(current, { デザイン: 100, 企画: 30 }, {}, {}) as { skill: string; level: number; acquiredAt?: string }[]
    expect(out).toEqual([{ skill: 'デザイン', level: 2, acquiredAt: '2026-01-01' }, { skill: '企画', level: 5 }, { skill: '手を付けていない', level: 1 }])
    // 新しい計算のレベルを超えた時だけ上がる(acquiredAt は残す)
    const up = gas.computeAutoLevels_(current, { デザイン: 360 }, {}, {}) as { skill: string; level: number; acquiredAt?: string }[]
    expect(up[0]).toEqual({ skill: 'デザイン', level: 3, acquiredAt: '2026-01-01' })
  })

  it('どんな点数・保存されたレベルでも、計算の後のレベルは保存されたレベル以上', () => {
    for (let stored = 1; stored <= 5; stored++) {
      for (let points = 0; points <= 900; points += 7) {
        const out = gas.computeAutoLevels_([{ skill: 'x', level: stored }], { x: points }, {}, {}) as { level: number }[]
        expect(out[0].level).toBeGreaterThanOrEqual(stored)
      }
    }
  })
})

describe('次のレベルまでの進み具合(画面の表示)', () => {
  it('100点で Lv.2 が保存されている人: Lv.2 のまま、次の Lv.3(350点)まで あと 250点。進み具合は 0(負にならない)', () => {
    const p = levelProgress(2, 100, 'デザイン', EMPTY_EVIDENCE)
    expect(p).toMatchObject({ level: 2, nextLevel: 3, nextPoints: 350, remaining: 250, ratio: 0, pendingConditions: [] })
  })

  it('保存されたレベル・点数のどんな組み合わせでも、レベルは保存されたレベル以上、あとの点数は 0 以上、進み具合は 0〜1', () => {
    const rulesList: SkillLevelRules[] = [{}, { default: { points: [0, 1, 2, 3, 4] } }, { skills: { x: { points: [500, 600, 700, 800, 900] } } }]
    for (const rules of rulesList) {
      for (const stored of [undefined, 1, 2, 3, 4, 5] as (SkillLevelValue | undefined)[]) {
        for (const points of [-50, 0, 1, 49, 50, 99, 100, 149, 150, 351, 549, 551, 749, 751, 5000, NaN]) {
          const p = levelProgress(stored, points, 'x', EMPTY_EVIDENCE, rules)
          expect(p.level).toBeGreaterThanOrEqual(stored ?? 0)
          expect(p.remaining).toBeGreaterThanOrEqual(0)
          expect(p.ratio).toBeGreaterThanOrEqual(0)
          expect(p.ratio).toBeLessThanOrEqual(1)
          expect(Number.isFinite(p.ratio)).toBe(true)
          if (p.nextLevel != null) expect(p.nextLevel).toBe(p.level + 1)
        }
      }
    }
  })

  it('点数は届いていても条件が足りない時は、その条件を出す(Lv.4 の資格)', () => {
    const p = levelProgress(3, 600, 'デザイン', EMPTY_EVIDENCE)
    expect(p).toMatchObject({ level: 3, nextLevel: 4, remaining: 0, ratio: 1 })
    expect(p.pendingConditions).toEqual([{ type: 'qualification', min: 1 }])
    expect(levelProgress(5, 10, 'デザイン', EMPTY_EVIDENCE)).toMatchObject({ level: 5, nextLevel: null, remaining: 0, ratio: 1 })
  })
})

describe('点数の一覧と条件', () => {
  it('スキルごとの一覧 → 団体の既定 → 組み込みの順に使う。空の条件の一覧は「条件なし」', () => {
    const rules: SkillLevelRules = { default: { points: [10, 20, 30, 40, 50] }, skills: { デザイン: { points: [100, 200, 300, 400, 500], conditions: { '4': [] } } } }
    expect(skillLevelOf(45, '企画', EMPTY_EVIDENCE, rules)).toBe(3) // Lv.4 は組み込みの資格の条件が残る
    expect(skillLevelOf(450, 'デザイン', EMPTY_EVIDENCE, rules)).toBe(4) // このスキルは Lv.4 の条件なし
    expect(skillLevelOf(450, 'ほか', EMPTY_EVIDENCE, {})).toBe(3)
  })

  it('検定の合格: そのスキル・そのレベル以上の合格がある時だけ上がる', () => {
    const rules: SkillLevelRules = { default: { conditions: { '3': [{ type: 'quiz' }] } } }
    const pass = (level: SkillLevelValue, skill = 'デザイン') => ev({ quizPasses: [{ quizId: 'q', skill, level, at: '' }] })
    expect(skillLevelOf(400, 'デザイン', EMPTY_EVIDENCE, rules)).toBe(2)
    expect(skillLevelOf(400, 'デザイン', pass(2), rules)).toBe(2)
    expect(skillLevelOf(400, 'デザイン', pass(3), rules)).toBe(3)
    expect(skillLevelOf(400, 'デザイン', pass(3, '企画'), rules)).toBe(2)
  })

  it('完了したタスクの数の下限', () => {
    const rules: SkillLevelRules = { default: { conditions: { '2': [{ type: 'tasksDone', min: 3 }] } } }
    expect(skillLevelOf(200, 'デザイン', ev({ doneTaskCounts: { デザイン: 2 } }), rules)).toBe(1)
    expect(skillLevelOf(200, 'デザイン', ev({ doneTaskCounts: { デザイン: 3 } }), rules)).toBe(2)
  })
})

describe('GAS: 本物の認証で、ポイントの付与・検定の合格・設定を通す', () => {
  let w: World
  let A: ReturnType<World['launchOrg']>
  let top = ''
  let me = ''
  beforeAll(() => {
    w = createWorld()
    A = w.launchOrg('団体A', 'contact@a.example')
    const login = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result
    top = login.session.token
    me = login.memberId
  })
  const member = (org: Org) => {
    const rows = org.sheets.Members.rows
    const head = rows[0].map(String)
    const r = rows.find((x) => String(x[head.indexOf('id')]) === me)!
    return Object.fromEntries(head.map((h, i) => [h, r[i]])) as Record<string, string>
  }
  const setMemberCell = (col: string, value: string) => {
    const rows = A.org.sheets.Members.rows
    const head = rows[0].map(String)
    const r = rows.find((x) => String(x[head.indexOf('id')]) === me)!
    r[head.indexOf(col)] = value
    A.org.cache.clear()
  }
  // 点数を直接足す(タスクの点数の付与は、完了・担当者・必要スキル・自分には付けない などの確かめがあるため)
  const addPoints = (points: Record<string, number>) => {
    ;(A.org.gas as unknown as { addSkillPoints_: (id: string, p: Record<string, number>) => void }).addSkillPoints_(me, points)
    A.org.cache.clear()
  }
  const levels = () => JSON.parse(member(A.org).skill_levels_json || '[]') as { skill: string; level: number }[]
  const levelOf = (skill: string) => levels().find((l) => l.skill === skill)?.level

  it('以前の計算で上がったレベル(100点で Lv.2)は、ポイントを足しても下がらない。新しい計算に届けば上がる', () => {
    // 以前の GAS の計算で保存されたレベル(点数 0 で Lv.2)
    setMemberCell('skill_levels_json', JSON.stringify([{ skill: 'デザイン', level: 2, acquiredAt: '2026-01-01' }]))
    addPoints({ デザイン: 100 })
    expect(levelOf('デザイン')).toBe(2)
    addPoints({ デザイン: 260 })
    expect(levelOf('デザイン')).toBe(3)
    // 資格が無いので、点数が Lv.4 に届いても Lv.3 のまま(組み込みの条件)
    addPoints({ デザイン: 300 })
    expect(levelOf('デザイン')).toBe(3)
  })

  it('団体の設定(skill_level_rules)に従う。検定の合格を記録し、検定が条件のレベルに上がれる', () => {
    const rules = { default: { points: [10, 20, 30, 40, 50], conditions: { '2': [{ type: 'quiz' }] } } }
    expect(w.call(A.org, top, 'updateSetting', { key: 'skill_level_rules', value: JSON.stringify(rules) }).ok).toBe(true)
    addPoints({ 企画: 25 })
    expect(levelOf('企画')).toBe(1) // Lv.2 は検定の合格が要る
    const quiz = { id: 'quiz-plan', title: '企画の基礎', targetSkill: '企画', targetLevel: 2, passRate: 50, questions: [{ text: 'Q', options: ['a', 'b'], correctIndex: 0 }] }
    expect(w.call(A.org, top, 'updateSetting', { key: 'quiz_definitions', value: JSON.stringify([quiz]) }).ok).toBe(true)
    const res = w.call(A.org, top, 'submitQuizResult', { quizId: 'quiz-plan', memberId: me, answers: [0] })
    expect(res.result).toMatchObject({ passed: true, newLevel: 2 })
    expect(JSON.parse(member(A.org).quiz_passes_json)).toMatchObject([{ quizId: 'quiz-plan', skill: '企画', level: 2 }])
    // 底上げする点数も、団体の一覧(Lv.2 = 20点)に従う
    expect(JSON.parse(member(A.org).skill_points_json).企画).toBe(25)
    // 画面にも設定が届く
    expect(JSON.parse(w.call(A.org, top, 'getInitialData').result.sheets.Settings.rows.find((r: string[]) => r[0] === 'skill_level_rules')[1])).toEqual(rules)
  })
})
