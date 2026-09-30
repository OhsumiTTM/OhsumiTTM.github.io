// 機能停止中(読み取り専用。R1-e)の画面の扱い(lib/ohsumi/read-only.ts): 止める欄・止めない欄、
// 作成・編集の操作を画面を変える前に止めること、送ろうとした文章を取り出すこと
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  READ_SAFE_STORE_FUNCTIONS,
  ReadOnlyBlockedError,
  applyReadOnlyInputs,
  blockedJustNow,
  extractUnsavedTexts,
  guardStoreWrites,
  isReadOnlyContract,
  shouldDisableForReadOnly,
} from './read-only'

const ROOT = join(__dirname, '..', '..')

// 画面の欄の偽物(closest は、自分か祖先に data-read-only-ok があるか)
function el(tag: string, type: string | null = null, ok = false, disabled = false) {
  const attrs = new Map<string, string>()
  if (type !== null) attrs.set('type', type)
  return {
    tagName: tag.toUpperCase(),
    disabled,
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { attrs.set(n, v) },
    removeAttribute: (n: string) => { attrs.delete(n) },
    hasAttribute: (n: string) => attrs.has(n),
    closest: (sel: string) => (ok && sel === '[data-read-only-ok]' ? {} : null),
  }
}

describe('止める欄', () => {
  it('文章・数値・日付を書く欄とファイルの選択は止める。選択肢・チェック・閲覧のための欄は止めない', () => {
    for (const [tag, type] of [['textarea', null], ['input', null], ['input', 'text'], ['input', 'number'], ['input', 'date'], ['input', 'file'], ['input', 'email']] as const) {
      expect(shouldDisableForReadOnly(el(tag, type)), `${tag} ${type}`).toBe(true)
    }
    for (const [tag, type] of [['select', null], ['input', 'checkbox'], ['input', 'radio'], ['input', 'range'], ['input', 'search'], ['button', null]] as const) {
      expect(shouldDisableForReadOnly(el(tag, type)), `${tag} ${type}`).toBe(false)
    }
    // 検索・期間・絞り込みの欄(data-read-only-ok)
    expect(shouldDisableForReadOnly(el('input', 'date', true))).toBe(false)
    expect(shouldDisableForReadOnly(el('textarea', null, true))).toBe(false)
  })

  it('止めた欄だけを戻す(もともと使えない欄は、戻す時も使えないまま)', () => {
    const text = el('textarea')
    const date = el('input', 'date', true)
    const already = el('input', 'text', false, true)
    const root = { querySelectorAll: () => [text, date, already] } as unknown as ParentNode
    expect(applyReadOnlyInputs(root, true, '読み取り専用')).toBe(1)
    expect([text.disabled, date.disabled, already.disabled]).toEqual([true, false, true])
    expect(text.getAttribute('title')).toBe('読み取り専用')
    // 何度呼んでも同じ
    expect(applyReadOnlyInputs(root, true, '読み取り専用')).toBe(0)
    applyReadOnlyInputs(root, false, '読み取り専用')
    expect([text.disabled, date.disabled, already.disabled]).toEqual([false, false, true])
    expect(text.getAttribute('title')).toBeNull()
  })

  it('GAS が機能停止中と伝えた時だけ読み取り専用。予定(日時を過ぎていても)・提供停止は違う', () => {
    expect(isReadOnlyContract({ phase: 'inEffect', kind: 'restrict', suspendAt: '' })).toBe(true)
    expect(isReadOnlyContract({ phase: 'scheduled', kind: 'restrict', suspendAt: '2020-01-01T00:00:00Z' })).toBe(false)
    expect(isReadOnlyContract({ phase: 'scheduled', kind: 'restrict', suspendAt: '2099-01-01T00:00:00Z' })).toBe(false)
    expect(isReadOnlyContract({ phase: 'inEffect', kind: 'suspend', suspendAt: '' })).toBe(false)
    expect(isReadOnlyContract({ phase: 'none', kind: '', suspendAt: '' })).toBe(false)
  })

  it('閲覧のための欄(検索・期間・絞り込み)には data-read-only-ok を付けている', () => {
    const marked: [string, string][] = [
      ['components/ohsumi/header.tsx', 'setQuery'],
      ['components/ohsumi/output/list-view.tsx', 'setQuery'],
      ['components/ohsumi/output/output-screen.tsx', 'setFromDate'],
      ['components/ohsumi/output/output-screen.tsx', 'setToDate'],
      ['components/ohsumi/admin/admin-members.tsx', 'setQuery'],
      ['components/ohsumi/admin/admin-members.tsx', 'setMinTenureYears'],
      ['components/ohsumi/admin/admin-members.tsx', 'setExperienceQuery'],
      ['components/ohsumi/admin/admin-daily-reports.tsx', 'setDateFilter'],
      ['components/ohsumi/admin/admin-member-db.tsx', 'setFilters'],
    ]
    for (const [file, setter] of marked) {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(src, `${file} ${setter}`).toMatch(new RegExp(`data-read-only-ok\\n\\s*onChange=\\{\\(e\\) => ${setter}\\(`))
    }
  })
})

describe('作成・編集の操作を止める', () => {
  it('読み取り・表示・ログインの関数はそのまま。それ以外は、元の関数を呼ばずに知らせ、失敗した Promise を返す', async () => {
    const addComment = vi.fn()
    const getMember = vi.fn(() => 'm')
    const blocked: [string, unknown[]][] = []
    const g = guardStoreWrites({ addComment, getMember, tasks: [1] }, (name, args) => blocked.push([name, args]))
    expect(g.getMember()).toBe('m')
    expect(g.tasks).toEqual([1])
    expect(blockedJustNow()).toBe(false)
    await expect(g.addComment('t1', '長いコメント')).rejects.toBeInstanceOf(ReadOnlyBlockedError)
    expect(addComment).not.toHaveBeenCalled()
    // 止めた直後は「保存しました」などの知らせを出さない(1秒)
    expect(blockedJustNow()).toBe(true)
    expect(blockedJustNow(Date.now() + 1500)).toBe(false)
    expect(blocked).toEqual([['addComment', ['t1', '長いコメント']]])
  })

  it('止めない関数の一覧は、store にある関数の名前だけ', () => {
    const src = readFileSync(join(ROOT, 'lib', 'ohsumi', 'store.tsx'), 'utf8')
    const value = src.slice(src.indexOf('const value: OhsumiContextValue = {'))
    for (const name of READ_SAFE_STORE_FUNCTIONS) expect(value, name).toMatch(new RegExp(`\\n\\s+${name},`))
  })
})

describe('送ろうとした文章(コピーできるように出す)', () => {
  it('人が書いた文章だけを、長い順に取り出す(ID・コード・日付・URL・画像は除く)', () => {
    const texts = extractUnsavedTexts({
      action: 'updateTaskDetails', sessionToken: 'v1.abc', requestId: 'req-1', taskId: 't-123', assigneeIds: ['m1'],
      name: '新しいタスク名', description: '長い説明\n2行目も書いた', status: 'done', deadline: '2026-10-01',
      image: 'data:image/png;base64,xxx', link: 'https://example.com/a', history: [{ comment: '了解です' }, { comment: '了解です' }],
    })
    expect(texts).toEqual(['長い説明\n2行目も書いた', '新しいタスク名', '了解です'])
    expect(extractUnsavedTexts(['t1', 'コメントの本文'])).toEqual(['コメントの本文'])
  })
})
