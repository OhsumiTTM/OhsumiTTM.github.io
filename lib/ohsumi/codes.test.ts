// 選択肢の値の内部コード: 変換の表と、GAS(gas/Code.gs)の表・通知の表示名が
// フロント(codes.ts・i18n)と一致することを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CLIENT_VERSION, VALUE_CODES, normalizeCode, normalizeThresholdKeys, sheetLabel, type CodeKind } from './codes'
import { ja } from './i18n/ja'
import { en } from './i18n/en'
import { SCHEDULE_ANSWER_KEY, DEPARTMENT_KEY, DIFFICULTY_KEY, IMPORTANCE_KEY, PRIORITY_KEY, STATUS_KEY } from './i18n'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function loadGas() {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}), getProperty: () => null }) },
  })
  vm.runInContext(CODE_GS, ctx)
  return ctx as unknown as {
    VALUE_CODES: unknown
    NOTIFY_LABELS: Record<string, Record<string, Record<string, string>>>
    MIN_CLIENT_VERSION: number
    normalizeCode: (kind: string, v: unknown) => string
  }
}

const KINDS = Object.keys(VALUE_CODES) as CodeKind[]

// 表にあるすべての値(コード・日本語・別名)と、表に無い値
function samplesOf(kind: CodeKind): unknown[] {
  const t = VALUE_CODES[kind]
  return [
    ...t.codes,
    ...Object.values(t.sheetLabels),
    ...Object.keys(t.aliases),
    ` ${Object.values(t.sheetLabels)[0]} `,
    '知らない値',
    undefined,
    null,
  ]
}

describe('変換の表', () => {
  it('今の日本語の値・コード・別名は、すべて同じコードになる', () => {
    for (const kind of KINDS) {
      const t = VALUE_CODES[kind]
      for (const code of t.codes) {
        expect(normalizeCode(kind, code), `${kind}:${code}`).toBe(code)
        expect(normalizeCode(kind, (t.sheetLabels as Record<string, string>)[code]), `${kind}:${code}`).toBe(code)
      }
      for (const [alias, code] of Object.entries(t.aliases)) {
        expect(normalizeCode(kind, alias), `${kind}:${alias}`).toBe(code)
      }
    }
    expect(normalizeCode('importance', '対外公開')).toBe('external')
    expect(normalizeCode('visibility', '幹部')).toBe('leaders')
    expect(normalizeCode('scheduleAnswer', '〇')).toBe('yes')
  })

  it('当てはまらない値は、以前と同じ既定値になる(部門・日程の回答はそのまま残す)', () => {
    expect(normalizeCode('status', 'typo')).toBe('progress')
    expect(normalizeCode('status', '')).toBe('progress')
    expect(normalizeCode('difficulty', '???')).toBe('beginner')
    expect(normalizeCode('priority', '')).toBe('medium')
    expect(normalizeCode('importance', '')).toBe('normal')
    expect(normalizeCode('visibility', '')).toBe('all')
    expect(normalizeCode('approval', '')).toBe('approved')
    expect(normalizeCode('department', '')).toBe('')
    expect(normalizeCode('department', '未分類')).toBe('')
    expect(normalizeCode('department', '独自の部門')).toBe('独自の部門')
  })

  it('コード同士・日本語同士に重複が無い', () => {
    for (const kind of KINDS) {
      const t = VALUE_CODES[kind]
      expect(new Set(t.codes).size, kind).toBe(t.codes.length)
      expect(new Set(Object.values(t.sheetLabels)).size, kind).toBe(t.codes.length)
      expect(Object.keys(t.sheetLabels).sort(), kind).toEqual([...t.codes].sort())
    }
  })

  it('Excel の書き出しは以前と同じ日本語', () => {
    expect(sheetLabel('priority', 'high')).toBe('高')
    expect(sheetLabel('department', '')).toBe('未分類')
    expect(sheetLabel('department', '独自の部門')).toBe('独自の部門')
  })

  it('スキルの閾値の「デフォルト」は _default として読む', () => {
    expect(normalizeThresholdKeys({ デフォルト: 120, デザイン: 150 })).toEqual({ _default: 120, デザイン: 150 })
    expect(normalizeThresholdKeys({ _default: 90, デフォルト: 120 })).toEqual({ _default: 90 })
  })

  it('すべてのコードに画面の表示名がある', () => {
    const maps: Partial<Record<CodeKind, Record<string, string>>> = {
      status: STATUS_KEY, difficulty: DIFFICULTY_KEY, priority: PRIORITY_KEY, importance: IMPORTANCE_KEY,
      department: DEPARTMENT_KEY, scheduleAnswer: SCHEDULE_ANSWER_KEY,
    }
    for (const [kind, keys] of Object.entries(maps) as [CodeKind, Record<string, keyof typeof ja>][]) {
      for (const code of VALUE_CODES[kind].codes) {
        expect(keys[code], `${kind}:${code}`).toBeTruthy()
        expect(ja[keys[code]], `${kind}:${code}`).toBeTruthy()
        expect(en[keys[code]], `${kind}:${code}`).toBeTruthy()
      }
    }
  })
})

describe('GAS との一致', () => {
  const gas = loadGas()

  it('GAS の VALUE_CODES は codes.ts と同じ内容', () => {
    expect(JSON.parse(JSON.stringify(gas.VALUE_CODES))).toEqual(JSON.parse(JSON.stringify(VALUE_CODES)))
  })

  it('GAS の normalizeCode は、どの値でもフロントと同じ結果になる', () => {
    for (const kind of KINDS) {
      for (const v of samplesOf(kind)) {
        expect(gas.normalizeCode(kind, v), `${kind}:${String(v)}`).toBe(normalizeCode(kind, v))
      }
    }
  })

  it('通知の文面の表示名(NOTIFY_LABELS)は、画面の i18n(ja.ts・en.ts)と同じ', () => {
    const dicts = { ja, en } as const
    for (const [kind, byLocale] of Object.entries(gas.NOTIFY_LABELS)) {
      expect(kind).toBe('scheduleAnswer')
      for (const locale of ['ja', 'en'] as const) {
        const expected = Object.fromEntries(
          VALUE_CODES.scheduleAnswer.codes.map((c) => [c, dicts[locale][SCHEDULE_ANSWER_KEY[c]]]),
        )
        expect({ ...byLocale[locale] }, `${kind}.${locale}`).toEqual(expected)
      }
    }
  })

  it('フロントの版は、GAS が移行後に受け付ける最小の版以上', () => {
    expect(CLIENT_VERSION).toBeGreaterThanOrEqual(gas.MIN_CLIENT_VERSION)
  })
})
