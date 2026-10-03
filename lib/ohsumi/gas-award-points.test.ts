// スキルの点数の付与(awardSkillPoints)を GAS で確かめることを確かめる
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

function setup() {
  const h = guardHarness()
  const rows = h.sheets.Tasks.rows
  const head = rows[0]
  head.push('skills', 'awarded_points_json')
  for (let r = 1; r < rows.length; r++) rows[r].push('', '')
  const set = (id: string, col: string, v: string) => {
    const r = rows.find((x) => x[0] === id)!
    r[head.indexOf(col)] = v
  }
  const mrows = h.sheets.Members.rows
  mrows[0].push('skill_points_json', 'skill_levels_json')
  for (let r = 1; r < mrows.length; r++) mrows[r].push('{}', '[]')
  set('t1', 'status', 'done')
  set('t1', 'skills', 'デザイン,企画')
  h.props.DATA_VERSION = 'v' + Math.random()
  const award = (who: string, body: Record<string, unknown>) =>
    h.post({ action: 'awardSkillPoints', sessionToken: who, taskId: 't1', memberId: 'm-base', points: { デザイン: 20 }, ...body })
  return { h, set, award }
}

describe('スキルの点数の付与', () => {
  it('完了したタスクの担当者に、必要スキルの点数を1回だけ付けられる', () => {
    const { award } = setup()
    const first = award('m-top', {})
    expect(first.ok, first.error).toBe(true)
    expect(first.result.newPoints).toMatchObject({ デザイン: 20 })
    const again = award('m-top', {})
    expect(again.ok).toBe(false)
    expect(String(again.error)).toContain('もう付けています')
  })
  it('完了していないタスクには付けられない', () => {
    const { h, set, award } = setup()
    set('t1', 'status', 'progress')
    h.props.DATA_VERSION = 'v' + Math.random()
    expect(award('m-top', {}).ok).toBe(false)
  })
  it('担当者でない人・必要スキルでないスキル・上限を超える点数・整数でない点数は断る', () => {
    const { award } = setup()
    expect(award('m-top', { memberId: 'm-lead' }).ok).toBe(false)
    expect(award('m-top', { points: { 営業: 10 } }).ok).toBe(false)
    expect(award('m-top', { points: { デザイン: 101 } }).ok).toBe(false)
    expect(award('m-top', { points: { デザイン: 1.5 } }).ok).toBe(false)
    expect(award('m-top', { points: { デザイン: -5 } }).ok).toBe(false)
  })
  it('自分自身には付けられない', () => {
    const { award } = setup()
    const r = award('m-base', {})
    expect(r.ok).toBe(false)
  })
})
