// 団体の GAS(gas/Code.gs)が、画面に頼らずに守るべきことを、全部の操作を実際に送って確かめる。
//   1. 通知(メール・Discord/Slack・通知のキュー)の宛先と本文は、保存したデータから GAS が決める
//      (画面から送られた宛先・本文をそのまま使わない。例外は NOTIFY_QUOTED_FIELDS に書いた項目だけ)
//   2. タスクを書き換える操作は、担当者などに限る一覧(TASK_OWNER_SCOPED_ACTIONS)・誰でもよい理由のある一覧
//      (TASK_ANY_MEMBER_ACTIONS)のどちらかに入っているか、役職で限っていて一般のメンバーは断られる
//   3. 通知・翻訳の回数の上限、進捗の記録、公募の応募、休止中のメンバー
// 新しく足した操作も、runWriteAction_ の case から自動で確かめる。最後に、守る処理を外した Code.gs で
// これらのテストが失敗することを確かめる
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, hostileBody, leakedFields, writeActions } from './gas-guard-harness'

type Harness = ReturnType<typeof guardHarness>
const ACTORS = ['m-top', 'm-other', 'm-base']

// ---- 1. 通知の宛先と本文 -------------------------------------------------------------

function notificationViolations(code: string): string[] {
  const out: string[] = []
  for (const action of writeActions(code)) {
    for (const actor of ACTORS) {
      const h = guardHarness({ code })
      h.post(hostileBody(action, actor))
      const quoted = ((h.c.NOTIFY_QUOTED_FIELDS as Record<string, string[]> | undefined) ?? {})[action] ?? []
      const saved = h.savedText()
      const emails = h.registeredEmails()
      for (const s of h.allSent()) {
        if (s.kind === 'mail') {
          for (const to of s.to.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
            if (!emails.has(to)) out.push(`${action}(${actor}): 登録されていない宛先 ${to}`)
          }
        }
        for (const f of leakedFields(s.text)) {
          // 保存したデータに入った文は、保存したデータから作った本文(例: 保存したコメント・タスク名)
          if (saved.includes(`MARK_${f}_`) || quoted.includes(f)) continue
          out.push(`${action}(${actor}): 画面から送られた ${f} が、保存されずに通知の本文に入った`)
        }
      }
    }
  }
  return [...new Set(out)]
}

// ---- 2. タスクを書き換える操作 ---------------------------------------------------------

// case の中で、タスクのシートを書き換える関数を呼ぶ操作(実際に送って書き換わらなかった操作も拾う)
function staticTaskWriters(code: string): string[] {
  const start = code.indexOf('function runWriteAction_(')
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10))
  const parts = body.split(/\n {4}case '(\w+)':/)
  const out = new Set<string>()
  let pending: string[] = []
  for (let i = 1; i < parts.length; i += 2) {
    pending.push(parts[i])
    const caseBody = parts[i + 1]
    if (!caseBody.trim()) continue
    if (/SHEET_TASKS|updateTaskFields_|createTasks_|removeTask_|rejectTask_|approveTaskReview_|moveDepartmentTasks_|generateRecurringTasks|notifyOverdueTasks/.test(caseBody)) pending.forEach((a) => out.add(a))
    pending = []
  }
  return [...out]
}

function taskWriteViolations(code: string): string[] {
  const out: string[] = []
  const probe = guardHarness({ code })
  const ownerScoped = (probe.c.TASK_OWNER_SCOPED_ACTIONS as string[] | undefined) ?? []
  const anyMember = (probe.c.TASK_ANY_MEMBER_ACTIONS as Record<string, string> | undefined) ?? {}
  const writers = new Set(staticTaskWriters(code))
  const results: Record<string, { res: Record<string, unknown>; wrote: boolean }> = {}
  for (const action of writeActions(code)) {
    for (const actor of ['m-top', 'm-other']) {
      const h: Harness = guardHarness({ code })
      const before = h.tasksJson()
      const res = h.post(hostileBody(action, actor))
      results[`${action}:${actor}`] = { res, wrote: before !== h.tasksJson() }
    }
    if (results[`${action}:m-top`].wrote) writers.add(action)
  }
  for (const action of writers) {
    const other = results[`${action}:m-other`]
    if (action in anyMember) {
      if (!String(anyMember[action] || '').trim()) out.push(`${action}: 誰でもよい理由が書かれていない`)
      continue
    }
    // 担当者などに限る・役職で限る操作は、タスクに関係の無い一般のメンバーが断られる(書き換わらない)
    if (other.wrote) out.push(`${action}: タスクに関係の無い一般のメンバーが書き換えられた(どちらの一覧にも入っていない)`)
    else if (!other.res.forbidden) out.push(`${action}: タスクに関係の無い一般のメンバーが権限で断られない(${String(other.res.error ?? 'ok')})`)
  }
  for (const action of ownerScoped) {
    if (!results[`${action}:m-other`]?.res.forbidden) out.push(`${action}: 担当者などに限る一覧にあるのに、関係の無い一般のメンバーが断られない`)
  }
  return out
}

describe('通知の宛先と本文は、GAS が保存したデータから決める(全部の操作)', () => {
  it('どの操作でも、画面から送られた宛先・本文(保存されない文)を通知に使わない', () => {
    expect(writeActions().length).toBeGreaterThan(120)
    expect(notificationViolations(CODE_GS)).toEqual([])
  })

  it('画面から本文を受け取る例外は、却下の理由だけ(理由を書いた一覧)', () => {
    const h = guardHarness()
    expect(h.c.NOTIFY_QUOTED_FIELDS).toEqual({ rejectTask: ['reason'] })
  })
})

describe('タスクを書き換える操作は、担当者などに限るか、誰でもよい理由がある(全部の操作)', () => {
  it('どの操作も、どちらかの一覧に入っているか、役職で限っていて一般のメンバーは断られる', () => {
    expect(taskWriteViolations(CODE_GS)).toEqual([])
  })

  it('担当者などに限る一覧に、進捗・保留の理由が入っている', () => {
    const h = guardHarness()
    expect(h.c.TASK_OWNER_SCOPED_ACTIONS).toEqual(expect.arrayContaining(['updateProgress', 'setHoldReason']))
  })
})

// ---- 3. 一つずつの決まり ----------------------------------------------------------------

function checkMentions(code: string) {
  const h = guardHarness({ code })
  // 担当者が「@班長」と書いたコメントを保存すると、班長に保存した文で知らせる。画面が送った宛先は使わない
  const res = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', memberIds: ['m-victim'],
    comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-1', byId: 'm-victim', text: '@班長 確認をお願いします' }] })
  expect(res.ok, res.error).toBe(true)
  const mails = h.sent.filter((s) => s.kind === 'mail')
  expect(mails.map((m) => m.to)).toEqual(['lead@example.com'])
  expect(mails[0].text).toContain('@班長 確認をお願いします')
  // 投稿者は本人にそろえる
  expect(h.sheets.Tasks.rows[1].join()).toContain('"id":"c-1","byId":"m-base"')
  // 以前の操作(画面が宛先・本文を送る)は、どの役職でも断る
  for (const actor of ['m-base', 'm-top']) {
    const old = h.post({ action: 'notifyMention', sessionToken: actor, taskId: 't1', commentText: '偽物', memberIds: ['m-victim'] })
    expect(old.ok).toBe(false)
  }
  expect(h.sent.filter((s) => s.to === 'victim@example.com')).toEqual([])
}

function checkRateLimits(code: string) {
  const h = guardHarness({ code })
  // 翻訳は1人1時間に上限まで(ここでは3件にする)
  ;(h.c.RATE_LIMITS as Record<string, { limit: number }>).translate.limit = 3
  expect(h.post({ action: 'translateText', sessionToken: 'm-base', texts: ['a', 'b'], targetLang: 'en' }).ok).toBe(true)
  const over = h.post({ action: 'translateText', sessionToken: 'm-base', texts: ['c', 'd'], targetLang: 'en' })
  expect(over.ok).toBe(false)
  expect(over.error).toMatch(/翻訳は1時間に3件まで/)
  // ほかの人は別に数える
  expect(h.post({ action: 'translateText', sessionToken: 'm-other', texts: ['c', 'd'], targetLang: 'en' }).ok).toBe(true)

  // 通知(メール・チャット)は、1人1時間に上限まで。超えた分は送らず、操作は成功させて notifyLimited を返す
  ;(h.c.RATE_LIMITS as Record<string, { limit: number }>).notify.limit = 2
  const results = [1, 2, 3].map((i) => h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
    comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, ...Array.from({ length: i }, (_, k) => ({ id: `c-r${k}`, byId: 'm-base', text: `@班長 ${k}` }))] }))
  expect(results.every((r) => r.ok)).toBe(true)
  expect(h.sent.filter((s) => s.kind === 'mail' && s.to === 'lead@example.com')).toHaveLength(2)
  expect(results[2].notifyLimited).toBe(true)

  // メンションの宛先の数も、1人1時間に上限まで(上限を超えるコメントでは誰にも送らない)
  const m = guardHarness({ code })
  ;(m.c.RATE_LIMITS as Record<string, { limit: number }>).mention.limit = 1
  const many = m.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
    comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-m', byId: 'm-base', text: '@班長 @代表 見てください' }] })
  expect(many.ok).toBe(true)
  expect(many.notifyLimited).toBe(true)
  expect(m.sent).toEqual([])
}

function checkProgress(code: string) {
  const h = guardHarness({ code })
  const old = { id: 'pg-old', byId: 'm-lead', text: '班長の進捗', at: '2026-09-01' }
  // 関係の無い一般のメンバーは書けない
  expect(h.post({ action: 'updateProgress', sessionToken: 'm-other', taskId: 't1', text: 'x', progressHistory: [old] }).forbidden).toBe(true)
  expect(h.post({ action: 'setHoldReason', sessionToken: 'm-other', taskId: 't1', note: 'x' }).forbidden).toBe(true)
  // 担当者は、自分の記録を足せる(書いた人は本人にそろえる)
  const ok = h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', text: '進めました', progressHistory: [{ id: 'pg-1', byId: 'm-lead', text: '進めました', at: '2026-10-01' }, old] })
  expect(ok.ok, ok.error).toBe(true)
  expect(String(h.sheets.Tasks.rows[1][h.sheets.Tasks.rows[0].indexOf('progress_history_json')])).toContain('"id":"pg-1","byId":"m-base"')
  // 他人の記録は消せない・変えられない
  const removed = h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressHistory: [] })
  expect(removed.forbidden).toBe(true)
  expect(removed.error).toMatch(/削除できません/)
  const edited = h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressHistory: [{ ...old, text: '書き換え' }] })
  expect(edited.forbidden).toBe(true)
  expect(edited.error).toMatch(/変更できません/)
}

function checkOpenBid(code: string) {
  const h = guardHarness({ code })
  // 自分の応募・取り下げはできる。ほかの人を足す・外すことはできない
  expect(h.post({ action: 'applyToOpenBid', sessionToken: 'm-other', taskId: 't-bid', applicantIds: ['m-lead', 'm-other'] }).ok).toBe(true)
  expect(h.post({ action: 'applyToOpenBid', sessionToken: 'm-other', taskId: 't-bid', applicantIds: ['m-lead'] }).ok).toBe(true)
  expect(h.post({ action: 'applyToOpenBid', sessionToken: 'm-other', taskId: 't-bid', applicantIds: ['m-lead', 'm-victim'] }).forbidden).toBe(true)
  expect(h.post({ action: 'applyToOpenBid', sessionToken: 'm-other', taskId: 't-bid', applicantIds: [] }).forbidden).toBe(true)
  // 幹部限定のタスクには応募できない
  expect(h.post({ action: 'applyToOpenBid', sessionToken: 'm-other', taskId: 't-exec', applicantIds: ['m-other'] }).forbidden).toBe(true)
}

function checkInactive(code: string) {
  const h = guardHarness({ code })
  // 休止中のメンバーは、操作も初期データの読み込みもできない(ログイン画面に戻す)
  expect(h.post({ action: 'updateComments', sessionToken: 'm-off', taskId: 't1', comments: [] })).toMatchObject({ ok: false, authError: true })
  const init = h.post({ action: 'getInitialData', sessionToken: 'm-off' })
  expect(init).toMatchObject({ ok: false, authError: true })
  expect(init.error).toMatch(/休止中/)
  // Google でログインしようとしても断る
  h.c.verifyGoogleIdToken_ = () => ({ email: 'off@example.com' })
  const login = h.post({ action: 'exchangeIdToken', idToken: 'x', nonceSecret: 'y' })
  expect(login.ok).toBe(false)
  expect(login.error).toMatch(/休止中/)

  // 休止にした時点で、そのメンバーのログイン(全端末)を無効にする。解除すれば、また使える
  const genKey = 'SESSION_GEN_m-base'
  const before = Number(h.props[genKey] || 0)
  expect(h.post({ action: 'updateMemberInactive', sessionToken: 'm-top', memberId: 'm-base', inactive: true }).ok).toBe(true)
  expect(Number(h.props[genKey])).toBe(before + 1)
  expect(h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 10 }).authError).toBe(true)
  expect(h.post({ action: 'updateMemberInactive', sessionToken: 'm-top', memberId: 'm-base', inactive: false }).ok).toBe(true)
  expect(h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 10 }).ok).toBe(true)
}

describe('メンションの通知', () => {
  it('保存したコメントの「@名前」から宛先を決め、保存した文で知らせる。以前の notifyMention は断る', () => checkMentions(CODE_GS))

  it('幹部限定のタスクでは、幹部限定のタスクを見られる人にだけ知らせる。休止中の人・書いた本人には送らない', () => {
    const h = guardHarness()
    const res = h.post({ action: 'updateComments', sessionToken: 'm-lead', taskId: 't-exec',
      comments: [{ id: 'c-x', byId: 'm-lead', text: '@代表 @他人 @休止 @班長 見てください' }] })
    expect(res.ok, res.error).toBe(true)
    expect(h.sent.filter((s) => s.kind === 'mail').map((s) => s.to)).toEqual(['top@example.com'])
  })
})

describe('通知を送る操作は、保存したデータだけで送る', () => {
  it('却下: シートのタスクの作成者に、シートのタスク名で知らせる(画面が送った作成者・名前は使わない)', () => {
    const h = guardHarness()
    const res = h.post({ action: 'rejectTask', sessionToken: 'm-lead', taskId: 't1', reason: '重複しています', creatorId: 'm-victim', taskName: '偽物' })
    expect(res.ok, res.error).toBe(true)
    // 却下の知らせは急ぎではないので、毎日のまとめに入る
    expect(h.sent).toEqual([])
    expect(h.digested().map((s) => s.to)).toEqual(['lead@example.com'])
    expect(h.digested()[0].text).toContain('「タスク1」')
    expect(h.digested()[0].text).toContain('理由: 重複しています')
    expect(h.sheets.Tasks.rows.some((r) => r[0] === 't1')).toBe(false)
  })

  it('研修: 保存した記録(申請中・承認済み)の時だけ、保存した名前で知らせる', () => {
    const h = guardHarness()
    expect(h.post({ action: 'notifyTrainingRequest', sessionToken: 'm-base', memberId: 'm-base', trainingId: 'tr-pending', trainingName: '偽物' }).result).toEqual({ sent: true })
    expect(h.sent.find((s) => s.kind === 'mail')?.text).toContain('保存した研修の名前')
    expect(h.sent.some((s) => s.text.includes('偽物'))).toBe(false)
    // 申請中でない記録・ほかの人の記録では送らない
    expect(h.post({ action: 'notifyTrainingRequest', sessionToken: 'm-base', memberId: 'm-base', trainingId: 'tr-ok' }).result).toEqual({ sent: false })
    expect(h.post({ action: 'notifyTrainingDecision', sessionToken: 'm-top', memberId: 'm-base', trainingId: 'tr-pending' }).result).toEqual({ sent: false })
    expect(h.post({ action: 'notifyTrainingDecision', sessionToken: 'm-top', memberId: 'm-base', trainingId: 'tr-ok' }).result).toEqual({ sent: true })
  })

  it('日程調整・フォームの結果: 保存した回答が揃った時に1回だけ知らせる', () => {
    const h = guardHarness()
    expect(h.post({ action: 'notifyScheduleResult', sessionToken: 'm-base', taskId: 't1' }).result).toEqual({ sent: true })
    expect(h.post({ action: 'notifyScheduleResult', sessionToken: 'm-base', taskId: 't1' }).result).toEqual({ sent: false })
    expect(h.post({ action: 'notifyFormResult', sessionToken: 'm-base', taskId: 't1' }).result).toEqual({ sent: true })
    // 回答が揃っていないタスクでは送らない
    expect(h.post({ action: 'notifyScheduleResult', sessionToken: 'm-base', taskId: 't-bid' }).result).toEqual({ sent: false })
    expect(h.digested().map((s) => s.to)).toEqual(['lead@example.com', 'lead@example.com'])
  })
})

describe('回数の上限', () => {
  it('翻訳・通知・メンションは、1人1時間の上限まで。通知は送らずに操作を成功させ、画面に知らせる', () => checkRateLimits(CODE_GS))
})

describe('進捗・保留の理由・公募', () => {
  it('進捗・保留の理由は、担当者などだけが書ける。他人の進捗の記録は変え・消せない', () => checkProgress(CODE_GS))
  it('公募は、自分の応募・取り下げだけ', () => checkOpenBid(CODE_GS))
})

describe('休止中のメンバー', () => {
  it('ログインできず、休止にした時点でセッションを無効にする。解除すれば使える', () => checkInactive(CODE_GS))
})

// ---- 守る処理を外すと、上のテストが失敗すること --------------------------------------------

function mutate(from: string | RegExp, to: string) {
  const next = CODE_GS.replace(from, to)
  expect(next, `書き換える場所が見つかりません: ${String(from)}`).not.toBe(CODE_GS)
  return next
}

describe('守る処理を外すと、テストが失敗する', () => {
  it('以前の notifyMention(画面が宛先・本文を送る)を戻すと、通知の決まりのテストが失敗する', () => {
    let code = mutate("var REMOVED_ACTIONS = ['notifyMention', 'notifyTaskRejected']", 'var REMOVED_ACTIONS = []')
    code = code.replace("\n    case 'notifyScheduleResult':\n      // 保存した回答", `\n    case 'notifyMention':
      ;(body.memberIds || []).forEach(function (mid) { queueNotification_(mid, 'mention', { ja: { subject: 'メンション', body: String(body.commentText) } }) })
      result = { ok: true }
      break
    case 'notifyScheduleResult':
      // 保存した回答`)
    code = code.replace("    'updateComments',\n", "    'updateComments',\n    'notifyMention',\n")
    expect(notificationViolations(code).join('\n')).toMatch(/notifyMention.*commentText/)
    expect(() => checkMentions(code)).toThrow()
  })

  it('updateProgress・setHoldReason を担当者などに限る一覧から外すと、タスクの決まりのテストが失敗する', () => {
    const code = mutate(/\n {2}'updateProgress', {3}\/\/[^\n]*\n {2}'setHoldReason', {4}\/\/[^\n]*\n/, '\n')
    const v = taskWriteViolations(code).join('\n')
    expect(v).toMatch(/updateProgress: タスクに関係の無い一般のメンバーが書き換えられた/)
    expect(v).toMatch(/setHoldReason: タスクに関係の無い一般のメンバーが書き換えられた/)
    expect(() => checkProgress(code)).toThrow()
  })

  it('回数の上限を外すと、回数の上限のテストが失敗する', () => {
    const code = mutate('  if (times.length + count > spec.limit) return false\n', '')
    expect(() => checkRateLimits(code)).toThrow()
  })

  it('進捗の記録の確かめを外すと、進捗のテストが失敗する', () => {
    const code = mutate("      if (action === 'updateProgress' && body.progressHistory !== undefined) validateProgressHistoryUpdate_(tosTask, body.progressHistory, acting)\n", '')
    expect(() => checkProgress(code)).toThrow()
  })

  it('公募の確かめを外すと、公募のテストが失敗する', () => {
    const code = mutate("        if (changed.some(function (x) { return x !== acting.id })) {", '        if (false) {')
    expect(() => checkOpenBid(code)).toThrow()
  })

  it('休止中の確かめを外すと、休止中のテストが失敗する', () => {
    const code = mutate('      if (actingMember.inactive) throw userError_(INACTIVE_MEMBER_MESSAGE)\n', '')
    expect(() => checkInactive(code)).toThrow()
    const noBump = mutate("      if (body.inactive) bumpSessionGeneration_(String(body.memberId))\n", '')
    expect(() => checkInactive(noBump)).toThrow()
  })
})
