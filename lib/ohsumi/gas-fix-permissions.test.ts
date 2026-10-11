// gas/Code.gs の権限の穴を塞いだことを、偽のスプレッドシートの上で実際に動かして確かめる。
// A1. members.hr・members.remove を持つ最上位でない人が、代表や自分より強い人・自分自身(範囲が広がる操作)を対象にできない
// A2. 担当プロジェクトが決まっている班長が、projectId を付けてほかのプロジェクトのタスクを編集・削除できない
// A4. 退会したメンバーを、最上位の役職の人として数えない
// B9. 同じメールアドレスを2人に登録させない(退会した人と同じアドレスで登録し直すと、ログインできなくなるため)
// どれも、正しい使い方(代表は何でもできる・班長は担当の一般メンバーを管理できる・今の画面の送り方)は今までどおり
import { describe, expect, it } from 'vitest'
import { guardHarness, type Cell } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>

// 班長に、できる操作(capability)を渡す。r-full は制限なしで団体のルールも持つ、班長より強い管理者
function withCaps(h: H, leadCaps: string[]) {
  h.sheets.Settings.rows[1][1] = JSON.stringify([
    { id: 'base', name: '一般', tier: 'base' },
    { id: 'r-lead', name: '班長', tier: 'admin', capabilities: leadCaps },
    { id: 'r-full', name: '事業責任者', tier: 'admin', capabilities: ['members.hr', 'members.remove', 'org.rules', 'trash'] },
    { id: 'top', name: '代表', tier: 'top' },
  ])
}

const memberHeaders = (h: H) => h.sheets.Members.rows[0].map(String)
function addMemberRow(h: H, o: Record<string, Cell>, email?: string) {
  h.sheets.Members.rows.push(memberHeaders(h).map((k) => o[k] ?? (k === 'permission_overrides_json' ? '[]' : '')))
  if (email) h.sheets.MemberEmails.rows.push([String(o.id), email])
}
function addColumns(h: H, names: string[]) {
  for (const n of names) {
    h.sheets.Members.rows[0].push(n)
    h.sheets.Members.rows.slice(1).forEach((r) => r.push(''))
  }
}
const addWithdrawnColumn = (h: H) => addColumns(h, ['withdrawn_at'])
function setMemberCell(h: H, id: string, col: string, v: Cell) {
  const head = memberHeaders(h)
  const row = h.sheets.Members.rows.find((r) => String(r[head.indexOf('id')]) === id)!
  row[head.indexOf(col)] = v
}
function memberCell(h: H, id: string, col: string): Cell | undefined {
  const head = memberHeaders(h)
  return h.sheets.Members.rows.find((r) => String(r[head.indexOf('id')]) === id)?.[head.indexOf(col)]
}
const emailOf = (h: H, id: string) => String(h.sheets.MemberEmails.rows.find((r) => String(r[0]) === id)?.[1] ?? '')
const loginAs = (h: H, email: string) => (h.c.findMemberIdByEmailCached_ as (e: string) => string | null)(email)

function addTaskP2(h: H) {
  const head = h.sheets.Tasks.rows[0].map(String)
  h.sheets.Tasks.rows.push(head.map((k) => ({ id: 't-p2', title: 'P2のタスク', project_id: 'p2', creator_id: 'm-top', status: 'todo', visibility: 'all', priority: 'medium' } as Record<string, Cell>)[k] ?? ''))
  h.sheets.Projects.rows.push(['p2', 'P2', 'm-victim', ''])
}
const hasTask = (h: H, id: string) => h.sheets.Tasks.rows.some((r) => String(r[0]) === id)

describe('A1. メンバーを対象にする操作(members.hr・members.remove)', () => {
  it('班長は、代表のメールアドレスに自分のアドレスを足せない(足したアドレスで代表としてログインできない)', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr'])
    const res = h.post({ action: 'updateEmail', sessionToken: 'm-lead', memberId: 'm-top', email: 'top@example.com,attacker@evil.example' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/最上位の役職/)
    expect(emailOf(h, 'm-top')).toBe('top@example.com')
    expect(loginAs(h, 'attacker@evil.example')).toBeNull()
  })

  it('班長は、代表の報告先・メンター・所属開始日・担当プロジェクトを変えられない', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr'])
    for (const body of [
      { action: 'updateReportsTo', memberId: 'm-top', reportsToId: 'm-lead' },
      { action: 'updateMentor', memberId: 'm-top', mentorId: 'm-lead' },
      { action: 'updateJoinedAt', memberId: 'm-top', joinedAt: '2026-01-01' },
      { action: 'updateMemberProjects', memberId: 'm-top', projectIds: ['p1'] },
    ]) {
      const res = h.post({ ...body, sessionToken: 'm-lead' })
      expect(res.ok, body.action).toBe(false)
    }
    expect(memberCell(h, 'm-top', 'project_ids')).toBe('')
  })

  it('班長は、自分の担当プロジェクトを外して(空にして)範囲を広げられない。自分の報告先も変えられない', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr'])
    const res = h.post({ action: 'updateMemberProjects', sessionToken: 'm-lead', memberId: 'm-lead', projectIds: [] })
    expect(res.ok).toBe(false)
    expect(memberCell(h, 'm-lead', 'project_ids')).toBe('p1')
    expect(h.post({ action: 'updateReportsTo', sessionToken: 'm-lead', memberId: 'm-lead', reportsToId: 'm-other' }).ok).toBe(false)
  })

  it('班長は、自分より強い人(自分の持っていない操作を持つ・制限なし)を対象にできない', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr', 'members.remove'])
    addMemberRow(h, { id: 'm-full', name: '責任者', role: 'r-full', locale: 'ja' }, 'full@example.com')
    expect(h.post({ action: 'updateEmail', sessionToken: 'm-lead', memberId: 'm-full', email: 'evil@evil.example' }).ok).toBe(false)
    expect(h.post({ action: 'removeMember', sessionToken: 'm-lead', memberId: 'm-full' }).ok).toBe(false)
    expect(emailOf(h, 'm-full')).toBe('full@example.com')
  })

  it('代表が2人いても、members.remove を持つ班長は代表を退会させられない', () => {
    const h = guardHarness()
    withCaps(h, ['members.remove'])
    addMemberRow(h, { id: 'm-top2', name: '代表2', role: 'top', locale: 'ja' }, 'top2@example.com')
    const res = h.post({ action: 'removeMember', sessionToken: 'm-lead', memberId: 'm-top' })
    expect(res.ok).toBe(false)
    expect(String(memberCell(h, 'm-top', 'inactive') ?? '')).toBe('')
  })

  it('班長は、担当プロジェクトの範囲の外のプロジェクトを付けられない', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr'])
    expect(h.post({ action: 'updateMemberProjects', sessionToken: 'm-lead', memberId: 'm-base', projectIds: ['p1', 'p2'] }).ok).toBe(false)
  })

  it('正しい使い方: 班長は一般のメンバーの報告先・メンター・所属開始日・メール・担当プロジェクトを変え、退会させられる', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr', 'members.remove'])
    addColumns(h, ['mentor_id', 'joined_at'])
    for (const body of [
      { action: 'updateReportsTo', memberId: 'm-base', reportsToId: 'm-lead' },
      { action: 'updateMentor', memberId: 'm-base', mentorId: 'm-other' },
      { action: 'updateJoinedAt', memberId: 'm-base', joinedAt: '2026-04-01' },
      { action: 'updateEmail', memberId: 'm-base', email: 'base@example.com,base2@example.com' },
      { action: 'updateMemberProjects', memberId: 'm-base', projectIds: ['p1'] },
      { action: 'updateMemberProjects', memberId: 'm-other', projectIds: [] },
      { action: 'removeMember', memberId: 'm-victim' },
    ]) {
      const res = h.post({ ...body, sessionToken: 'm-lead' })
      expect(res.ok, body.action + ': ' + res.error).toBe(true)
    }
    expect(emailOf(h, 'm-base')).toBe('base@example.com,base2@example.com')
    expect(loginAs(h, 'base2@example.com')).toBe('m-base')
  })

  it('正しい使い方: 個人設定の画面から、自分のメールアドレスを足せる・所属開始日を直せる', () => {
    const h = guardHarness()
    withCaps(h, ['members.hr'])
    addColumns(h, ['joined_at'])
    expect(h.post({ action: 'updateEmail', sessionToken: 'm-lead', memberId: 'm-lead', email: 'lead@example.com,lead2@example.com' }).ok).toBe(true)
    expect(h.post({ action: 'updateJoinedAt', sessionToken: 'm-lead', memberId: 'm-lead', joinedAt: '2026-04-01' }).ok).toBe(true)
    expect(loginAs(h, 'lead2@example.com')).toBe('m-lead')
  })

  it('正しい使い方: 代表は、ほかの代表・班長・自分を含めて何でもできる', () => {
    const h = guardHarness()
    withCaps(h, [])
    addMemberRow(h, { id: 'm-top2', name: '代表2', role: 'top', locale: 'ja' }, 'top2@example.com')
    for (const body of [
      { action: 'updateEmail', memberId: 'm-top2', email: 'top2@example.com,top2b@example.com' },
      { action: 'updateEmail', memberId: 'm-top', email: 'top@example.com,top-b@example.com' },
      { action: 'updateMemberProjects', memberId: 'm-lead', projectIds: [] },
      { action: 'updateMemberProjects', memberId: 'm-top', projectIds: ['p1'] },
      { action: 'updateReportsTo', memberId: 'm-top', reportsToId: 'm-top2' },
      { action: 'removeMember', memberId: 'm-top2' },
    ]) {
      const res = h.post({ ...body, sessionToken: 'm-top' })
      expect(res.ok, body.action + ': ' + res.error).toBe(true)
    }
  })
})

describe('A2. 班長のプロジェクトの範囲(タスクの操作)', () => {
  it('projectId に担当のプロジェクトを付けても、ほかのプロジェクトのタスクは編集・削除できない', () => {
    const h = guardHarness()
    addTaskP2(h)
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't-p2', priority: 'high' }).ok).toBe(false)
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't-p2', projectId: 'p1', priority: 'high' }).ok).toBe(false)
    const res = h.post({ action: 'removeTask', sessionToken: 'm-lead', taskId: 't-p2', projectId: 'p1' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/担当プロジェクトの範囲/)
    expect(hasTask(h, 't-p2')).toBe(true)
  })

  it('担当のプロジェクトのタスクを、範囲の外のプロジェクトへ移せない', () => {
    const h = guardHarness()
    addTaskP2(h)
    const res = h.post({ action: 'updateTaskDetails', sessionToken: 'm-lead', taskId: 't1', name: 'タスク1', description: '', projectId: 'p2',
      department: '', category: '', skills: [], difficulty: 'medium', priority: 'medium', visibility: 'all', importance: 'normal' })
    expect(res.ok).toBe(false)
    expect(h.tasksJson()).not.toContain('"t1","タスク1","","p2"')
  })

  it('正しい使い方: 担当のプロジェクトのタスクは、今の画面の送り方のまま編集・削除できる。代表はどのタスクも', () => {
    const h = guardHarness()
    addTaskP2(h)
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high' }).ok).toBe(true)
    const det = h.post({ action: 'updateTaskDetails', sessionToken: 'm-lead', taskId: 't1', name: 'タスク1(改)', description: '', projectId: 'p1',
      department: '', category: '', skills: [], difficulty: 'medium', priority: 'medium', visibility: 'all', importance: 'normal' })
    expect(det.ok, det.error).toBe(true)
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-top', taskId: 't-p2', projectId: 'p1', priority: 'high' }).ok).toBe(true)
    expect(h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't-p2' }).ok).toBe(true)
  })
})

describe('A4. 退会したメンバーを、最上位の役職の人として数えない', () => {
  it('退会した前の代表が残っていても、ただ1人の有効な代表は自分の役職を下げられない', () => {
    const h = guardHarness()
    addWithdrawnColumn(h)
    addMemberRow(h, { id: 'm-old', name: '前の代表', role: 'top', locale: 'ja', inactive: '', withdrawn_at: '2026-09-01T00:00:00.000Z' }, 'old@example.com')
    const res = h.post({ action: 'updateRole', sessionToken: 'm-top', memberId: 'm-top', role: 'base' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/最上位の役職を持つ有効なメンバーが0人/)
    expect(memberCell(h, 'm-top', 'role')).toBe('top')
  })

  it('代表が全員退会していれば、代表はいないものとして扱う(初期設定コードで入れ直せる)', () => {
    const h = guardHarness()
    addWithdrawnColumn(h)
    const hasTop = () => (h.c.hasTopMember_ as () => boolean)()
    expect(hasTop()).toBe(true)
    setMemberCell(h, 'm-top', 'withdrawn_at', '2026-09-01T00:00:00.000Z')
    expect(hasTop()).toBe(false)
    expect((h.c.topMemberIds_ as () => string[])()).toEqual([])
  })

  it('正しい使い方: 有効な代表がもう1人いれば、自分の役職を下げられる。休止中の代表も代表として数える', () => {
    const h = guardHarness()
    addWithdrawnColumn(h)
    addMemberRow(h, { id: 'm-top2', name: '代表2', role: 'top', locale: 'ja', inactive: 'TRUE' }, 'top2@example.com')
    expect((h.c.topMemberIds_ as () => string[])()).toEqual(['m-top', 'm-top2'])
    setMemberCell(h, 'm-top2', 'inactive', '')
    const res = h.post({ action: 'updateRole', sessionToken: 'm-top', memberId: 'm-top', role: 'base' })
    expect(res.ok, res.error).toBe(true)
  })
})

describe('B9. 同じメールアドレスを2人に登録させない', () => {
  it('退会したメンバーと同じアドレスでは、新しく登録せず「退会の取り消し」を案内する(大文字・小文字は区別しない)', () => {
    const h = guardHarness()
    expect(h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' }).ok).toBe(true)
    const rowsBefore = h.sheets.Members.rows.length
    const res = h.post({ action: 'addMember', sessionToken: 'm-top', name: '戻ってきた人', email: 'BASE@Example.com', affiliation: '', role: 'base' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/退会の取り消し/)
    expect(h.sheets.Members.rows.length).toBe(rowsBefore)
  })

  it('ほかのメンバーのアドレスは、登録にも、メールアドレスの変更(複数のアドレスの1つでも)にも使えない', () => {
    const h = guardHarness()
    expect(h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'other@example.com', affiliation: '' }).ok).toBe(false)
    const res = h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-victim', email: 'victim@example.com, Other@Example.com' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ほかのメンバー/)
    expect(emailOf(h, 'm-victim')).toBe('victim@example.com')
    expect(loginAs(h, 'other@example.com')).toBe('m-other')
  })

  it('初期設定コードで代表を入れ直す時は、退会した前の代表のアドレスをそのまま使える(新しい行でログインできる)', () => {
    const h = guardHarness()
    expect(h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' }).ok).toBe(true)
    const added = (h.c.addMember_ as (...a: unknown[]) => { id: string })('base', 'base@example.com', '', 'top', { firstLeader: true, takeOverWithdrawn: true })
    expect(loginAs(h, 'base@example.com')).toBe(added.id)
    expect(emailOf(h, 'm-base')).toBe('')
  })

  it('正しい使い方: 新しいアドレスなら登録できる。自分のアドレスの付け直しも断らない', () => {
    const h = guardHarness()
    const res = h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'new@example.com', affiliation: '' })
    expect(res.ok, res.error).toBe(true)
    expect(h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-other', email: 'OTHER@example.com,other2@example.com' }).ok).toBe(true)
  })
})
