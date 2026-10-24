// 団体をまたいだスキルの引き継ぎ(v1.2。gas/src/44-skill-transfer.gs と registry/Code.gs): 本物のレジストリと3つの団体で確かめる。
// 本人だけが作る・受け取る / 共通スキルだけ / 出どころごとに持って合計に足す / A→B→C で A の分も届き、同じ人の同じ団体の分は1つ /
// 本人のメールにコードを送る / 退会で自動で作って送る / 出どころごとに消す
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SKILL_OPTIONS } from './store'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorld, type Org, type World } from './e2e/world'

type Row = Record<string, string>
const rowsOf = (org: Org, sheet: string): Row[] => {
  const rows = org.sheets[sheet]?.rows ?? []
  const head = (rows[0] ?? []).map(String)
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '')])))
}
const memberRow = (org: Org, id: string) => rowsOf(org, 'Members').find((m) => m.id === id)!
const setCell = (org: Org, id: string, col: string, value: string) => {
  const rows = org.sheets.Members.rows
  const head = rows[0].map(String)
  if (!head.includes(col)) { rows[0].push(col); rows.slice(1).forEach((r) => r.push('')) }
  rows.find((r) => String(r[0]) === id)![rows[0].map(String).indexOf(col)] = value
  org.cache.clear()
}

let w: World
const O = {} as Record<'A' | 'B' | 'C', ReturnType<World['launchOrg']>>
const me = {} as Record<'A' | 'B' | 'C', { token: string; id: string }>
const top = {} as Record<'A' | 'B' | 'C', string>

beforeAll(() => {
  w = createWorld()
  for (const k of ['A', 'B', 'C'] as const) {
    O[k] = w.launchOrg('団体' + k, 'contact@' + k.toLowerCase() + '.example')
    top[k] = String(w.googleLogin(O[k].org, 'top@' + k.toLowerCase() + '.example', { setupCode: O[k].setupCode }).result.session.token)
    w.call(O[k].org, top[k], 'addMember', { name: '一般さん', email: 'person@' + k.toLowerCase() + '.example', affiliation: '', role: 'base', sendInvite: false })
    const login = w.googleLogin(O[k].org, 'person@' + k.toLowerCase() + '.example')
    me[k] = { token: String(login.result.session.token), id: String(login.result.memberId) }
  }
  // 団体A での実績(独自のスキルは引き継がない)
  setCell(O.A.org, me.A.id, 'skill_points_json', JSON.stringify({ デザイン: 120, 団体A独自: 50 }))
  setCell(O.A.org, me.A.id, 'skill_levels_json', JSON.stringify([{ skill: 'デザイン', level: 2 }]))
  setCell(O.A.org, me.A.id, 'qualifications_json', JSON.stringify([{ id: 'q1', name: '色彩検定3級', acquiredDate: '2025-06-01' }]))
})

const ledger = (k: 'A' | 'B' | 'C') => JSON.parse(memberRow(O[k].org, me[k].id).external_skills_json || '[]') as { transferId: string; originOrgName: string; via: string; points: Record<string, number> }[]
const points = (k: 'A' | 'B' | 'C') => JSON.parse(memberRow(O[k].org, me[k].id).skill_points_json || '{}') as Record<string, number>

describe('スキルの引き継ぎ(団体の GAS)', () => {
  it('共通スキルの一覧は、画面の既定と同じ', () => {
    const src = readFileSync(join(__dirname, '../../gas/src/44-skill-transfer.gs'), 'utf8')
    const list = JSON.parse(src.match(/var COMMON_SKILL_NAMES = (\[[^\]]+\])/)![1].replace(/'/g, '"').replace(/\s+/g, ' '))
    expect(list).toEqual([...DEFAULT_SKILL_OPTIONS])
  })

  let codeA = ''
  it('A で本人がコードを作ると、本人のメールにも届く。B で本人が入れると、共通スキルの分だけが出どころ付きで足される', () => {
    const made = w.call(O.A.org, me.A.token, 'createSkillTransferCode')
    expect(made.ok, made.error).toBe(true)
    codeA = String(made.result.code)
    expect(made.result.mailed).toBe(true)
    expect(O.A.org.mails.some((m) => m.to.includes('person@a.example') && m.body.includes(codeA))).toBe(true)
    expect(JSON.parse(memberRow(O.A.org, me.A.id).skill_transfers_json)[0]).toMatchObject({ transferId: made.result.transferId, status: 'pending' })
    // 本人のデータは本人の画面だけ(ほかの一般のメンバーには、作ったコードの記録は届かない)
    setCell(O.B.org, me.B.id, 'skill_points_json', JSON.stringify({ 企画: 40 }))
    const got = w.call(O.B.org, me.B.token, 'claimSkillTransferCode', { code: codeA.toLowerCase() })
    expect(got.ok, got.error).toBe(true)
    expect(got.result.added).toEqual([expect.objectContaining({ originOrgName: '団体A', via: '' })])
    expect(points('B')).toEqual({ 企画: 40, デザイン: 120 })
    expect(ledger('B')).toEqual([expect.objectContaining({ originOrgName: '団体A', points: { デザイン: 120 } })])
    const quals = JSON.parse(memberRow(O.B.org, me.B.id).qualifications_json)
    expect(quals).toEqual([expect.objectContaining({ name: '色彩検定3級', transferId: ledger('B')[0].transferId })])
    // レベルは B の決まりで計算し直す(下げない)
    expect(JSON.parse(memberRow(O.B.org, me.B.id).skill_levels_json).some((l: { skill: string }) => l.skill === 'デザイン')).toBe(true)
    // 同じコードは2回使えない
    expect(w.call(O.C.org, me.C.token, 'claimSkillTransferCode', { code: codeA }).ok).toBe(false)
  })

  it('B→C: B で得た分と、A から引き継いだ分の両方が C に届く。A から直接もう一度送っても、A の分は1つ(新しい方)', () => {
    const b = w.call(O.B.org, me.B.token, 'createSkillTransferCode')
    expect(b.ok, b.error).toBe(true)
    const got = w.call(O.C.org, me.C.token, 'claimSkillTransferCode', { code: b.result.code })
    expect(got.ok, got.error).toBe(true)
    expect(ledger('C').map((e) => [e.originOrgName, e.via])).toEqual([['団体B', ''], ['団体A', '団体B']])
    expect(points('C')).toEqual({ 企画: 40, デザイン: 120 })
    // A で点数が増えた後に、A から直接 C へ
    setCell(O.A.org, me.A.id, 'skill_points_json', JSON.stringify({ デザイン: 150, 団体A独自: 50 }))
    const a2 = w.call(O.A.org, me.A.token, 'createSkillTransferCode')
    const got2 = w.call(O.C.org, me.C.token, 'claimSkillTransferCode', { code: a2.result.code })
    expect(got2.ok, got2.error).toBe(true)
    expect(points('C')).toEqual({ 企画: 40, デザイン: 150 })
    expect(ledger('C').filter((e) => e.originOrgName === '団体A')).toHaveLength(1)
  })

  it('受け取った分は、本人と代表が出どころごとに消せる(ほかの一般のメンバーは消せない)', () => {
    const fromB = ledger('C').find((e) => e.originOrgName === '団体B')!
    w.call(O.C.org, top.C, 'addMember', { name: '他人さん', email: 'other@c.example', affiliation: '', role: 'base', sendInvite: false })
    const other = String(w.googleLogin(O.C.org, 'other@c.example').result.session.token)
    expect(w.call(O.C.org, other, 'removeTransferredSkills', { memberId: me.C.id, transferId: fromB.transferId }).ok).toBe(false)
    const res = w.call(O.C.org, me.C.token, 'removeTransferredSkills', { memberId: me.C.id, transferId: fromB.transferId })
    expect(res.ok, res.error).toBe(true)
    expect(points('C')).toEqual({ 企画: 0, デザイン: 150 })
    const fromA = ledger('C')[0]
    expect(w.call(O.C.org, top.C, 'removeTransferredSkills', { memberId: me.C.id, transferId: fromA.transferId }).ok).toBe(true)
    expect(ledger('C')).toEqual([])
  })

  it('作ったコードは本人が取り消せる。退会させると、コードを自動で作って本人に送る', () => {
    const made = w.call(O.A.org, me.A.token, 'createSkillTransferCode')
    expect(w.call(O.A.org, me.A.token, 'cancelSkillTransferCode', { transferId: made.result.transferId }).result).toMatchObject({ status: 'cancelled' })
    expect(w.call(O.B.org, me.B.token, 'claimSkillTransferCode', { code: made.result.code }).ok).toBe(false)
    const before = O.A.org.mails.length
    const removed = w.call(O.A.org, top.A, 'removeMember', { memberId: me.A.id })
    expect(removed.ok, removed.error).toBe(true)
    const mail = O.A.org.mails.slice(before).find((m) => m.to.includes('person@a.example') && m.subject.includes('引き継ぎコード'))
    expect(mail?.body).toContain('退会したため')
    const code = mail!.body.match(/引き継ぎコード: ([A-Z0-9-]+)/)![1]
    expect(w.call(O.B.org, me.B.token, 'claimSkillTransferCode', { code }).ok).toBe(true)
  })
})
