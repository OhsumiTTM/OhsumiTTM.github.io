// タスクなどの選択肢の値を、画面の言語によらない内部コードで扱うための表。
//
// 以前の団体のシート・手で直したシート・古いバックアップには日本語の値が
// 入っていることがある。どちらの形式の値も、読む時にこの表で
// コードにそろえる(normalizeCode)。書く時の形式は GAS が決める
// (Settings の value_format が codes になるまでは日本語で書く)。
//
// gas/Code.gs の VALUE_CODES は、この表と同じ内容を持つ(GAS は TypeScript を
// 読み込めないため)。両者が一致することは lib/ohsumi/codes.test.ts で確かめる。

export type CodeKind =
  | 'status'
  | 'difficulty'
  | 'priority'
  | 'importance'
  | 'visibility'
  | 'approval'
  | 'department'
  | 'scheduleAnswer'

interface CodeTable {
  // コードの一覧(表示・選択肢の順)
  codes: readonly string[]
  // 移行前のシートの値(日本語)。移行前の形式で書く時にも使う
  sheetLabels: Record<string, string>
  // そのほかに受け付ける別名(以前の英語の値・表記ゆれ)
  aliases: Record<string, string>
  // どれにも当てはまらない時のコード。null はそのままの値を残す(部門)
  fallback: string | null
}

export const VALUE_CODES = {
  status: {
    codes: ['todo', 'hold', 'progress', 'support', 'review', 'fix', 'done'],
    sheetLabels: { todo: '未着手', hold: '保留', progress: '進行中', support: 'サポート必要', review: '確認待ち', fix: '修正中', done: '完了' },
    aliases: {},
    // 以前から、読めない値は進行中として扱っている
    fallback: 'progress',
  },
  difficulty: {
    codes: ['anyone', 'beginner', 'some_exp', 'experienced', 'advanced'],
    sheetLabels: { anyone: '誰でも可', beginner: '新人歓迎', some_exp: '少し経験必要', experienced: '経験者向け', advanced: '上級者向け' },
    aliases: {},
    fallback: 'beginner',
  },
  priority: {
    codes: ['high', 'medium', 'low'],
    sheetLabels: { high: '高', medium: '中', low: '低' },
    aliases: {},
    fallback: 'medium',
  },
  importance: {
    codes: ['normal', 'important', 'external'],
    sheetLabels: { normal: '一般', important: '重要', external: '対外公開' },
    aliases: { '': 'normal' },
    fallback: 'normal',
  },
  visibility: {
    codes: ['all', 'leaders'],
    sheetLabels: { all: '全員', leaders: '幹部' },
    aliases: { '': 'all' },
    fallback: 'all',
  },
  approval: {
    codes: ['pending', 'approved'],
    sheetLabels: { pending: '承認待ち', approved: '承認済み' },
    // 空は承認済みと同じ扱い(承認の仕組みができる前の行)
    aliases: { '': 'approved' },
    fallback: 'approved',
  },
  department: {
    // 未分類は部門ではなく空で表す
    codes: ['ops', 'pr', 'dev', 'design', 'relations', 'event', 'research', ''],
    sheetLabels: { ops: '運営', pr: '広報', dev: '開発', design: 'デザイン', relations: '渉外', event: 'イベント', research: 'リサーチ', '': '未分類' },
    aliases: {},
    // 一覧に無い部門名は、消さずにそのまま残す
    fallback: null,
  },
  scheduleAnswer: {
    codes: ['yes', 'maybe', 'no'],
    sheetLabels: { yes: '○', maybe: '△', no: '×' },
    aliases: { '〇': 'yes', '✕': 'no' },
    fallback: null,
  },
} as const satisfies Record<CodeKind, CodeTable>

export type CodeOf<K extends CodeKind> = (typeof VALUE_CODES)[K]['codes'][number]

// どの形式の値(コード・移行前の日本語・別名)でも、コードにそろえる
export function normalizeCode<K extends CodeKind>(kind: K, value: unknown): CodeOf<K> {
  const table: CodeTable = VALUE_CODES[kind]
  const v = value == null ? '' : String(value).trim()
  if ((table.codes as readonly string[]).includes(v)) return v as CodeOf<K>
  for (const code of table.codes) {
    if (table.sheetLabels[code] === v) return code as CodeOf<K>
  }
  if (Object.prototype.hasOwnProperty.call(table.aliases, v)) return table.aliases[v] as CodeOf<K>
  return (table.fallback ?? v) as CodeOf<K>
}

// スキルのレベルアップの閾値(Settings の skill_level_thresholds)で、
// スキル名の代わりに既定値を表すキー。移行前は「デフォルト」
export const DEFAULT_THRESHOLD_KEY = '_default'
export const LEGACY_DEFAULT_THRESHOLD_KEY = 'デフォルト'

export function normalizeThresholdKeys(thresholds: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(thresholds)) {
    if (k === LEGACY_DEFAULT_THRESHOLD_KEY) {
      if (!(DEFAULT_THRESHOLD_KEY in thresholds)) out[DEFAULT_THRESHOLD_KEY] = v
    } else {
      out[k] = v
    }
  }
  return out
}

// フロントが GAS へ送るリクエストの版。移行の後、GAS はこれより古い
// (または付いていない)リクエストを、ページの再読み込みを促して拒否する。
// コードの扱いを変えた時に上げる(gas/Code.gs の MIN_CLIENT_VERSION と合わせる)
export const CLIENT_VERSION = 1

// 移行前のシートの値(日本語の表示名)。Excel の書き出しなど、以前と同じく
// 日本語で出したい所で使う。一覧に無い値はそのまま返す
export function sheetLabel(kind: CodeKind, code: string): string {
  const labels: Record<string, string> = VALUE_CODES[kind].sheetLabels
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}
