// 公開前の通しテスト(API の部分): レジストリと2つの団体の GAS を空のスプレッドシートから動かし、
// ログイン・セッション・権限の確かめは本物のコードのまま、公開の日にする操作を順に確かめる(lib/ohsumi/e2e/world.ts)。
// 画面(ブラウザ)の部分は e2e/browser.e2e.ts(pnpm test:e2e)。Google の本物のログインは、docs/release-e2e.md の手順で人が確かめる
import { beforeAll, describe, expect, it } from 'vitest'
import { createWorld, fakeIdToken, sha256B64url, type Org, type World } from './e2e/world'

type Row = Record<string, string>
const rowsOf = (org: Org, sheet: string): Row[] => {
  const rows = org.sheets[sheet]?.rows ?? []
  const head = (rows[0] ?? []).map(String)
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '')])))
}
const taskOf = (org: Org, id: string) => rowsOf(org, 'Tasks').find((t) => t.id === id)!
const taskIds = (data: { sheets?: { Tasks?: { headers: string[]; rows: string[][] } } }) => {
  const t = data.sheets?.Tasks
  if (!t) return []
  const i = t.headers.indexOf('id')
  return t.rows.map((r) => r[i])
}

let w: World
let A: ReturnType<World['launchOrg']>
let B: ReturnType<World['launchOrg']>
const tok: Record<string, string> = {}

beforeAll(() => {
  w = createWorld()
  A = w.launchOrg('団体A', 'contact@a.example')
  B = w.launchOrg('団体B', 'contact@b.example')
})

describe('1. 新しい団体の立ち上げ(登録コード → 団体の GAS の登録 → 初期設定コードで最初の代表)', () => {
  it('レジストリに2つの団体が登録され、それぞれ別の団体ID・接続先になる', () => {
    const orgs = w.reg.post({ action: 'adminOverview', session: w.adminSession }).result.orgs
    expect(orgs.map((o: { orgId: string }) => o.orgId).sort()).toEqual([A.orgId, B.orgId].sort())
    expect(A.orgId).not.toBe(B.orgId)
    // 接続先の解決(招待リンク ?org= で開いた時)
    expect(w.reg.post({ action: 'resolveOrg', orgId: A.orgId }).result.gasUrl).toBe(A.org.gasUrl)
  })

  it('初期設定コードで、最初のアカウントが代表になる。コードは1回だけ使える', () => {
    const top = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode })
    expect(top.ok, JSON.stringify(top).slice(0, 300)).toBe(true)
    expect(top.result.memberId).toBeTruthy()
    tok.topA = top.result.session.token
    const members = rowsOf(A.org, 'Members')
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('top')
    // 同じコードを別のアカウントで使っても、代表にならない
    const again = w.googleLogin(A.org, 'intruder@example.com', { setupCode: A.setupCode })
    expect(again.ok && again.result.memberId).toBeFalsy()
    expect(rowsOf(A.org, 'Members')).toHaveLength(1)
    const topB = w.googleLogin(B.org, 'top@b.example', { setupCode: B.setupCode })
    tok.topB = topB.result.session.token
  })
})

describe('2. ログイン', () => {
  it('登録されていないアカウントは、メンバーとして入れない(本人のメールアドレスだけ返す)', () => {
    const r = w.googleLogin(A.org, 'stranger@example.com')
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ memberId: null, email: 'stranger@example.com' })
    expect(r.result.session).toBeUndefined()
  })

  it('ほかの団体のための ID トークン(nonce が違う)・壊れたトークン・使い回しは断る', () => {
    expect(w.googleLogin(A.org, 'top@a.example', { nonceOrgId: B.orgId }).ok).toBe(false)
    const bad = A.org.post({ action: 'exchangeIdToken', idToken: fakeIdToken({ email: 'top@a.example', invalid: true }), nonceSecret: 'n'.repeat(20) })
    expect(bad.ok).toBe(false)
    const secret = 'nonce-secret-replay-000001'
    const idToken = fakeIdToken({ email: 'top@a.example', nonce: A.orgId + '.' + sha256B64url(secret) })
    expect(A.org.post({ action: 'exchangeIdToken', idToken, nonceSecret: secret }).ok).toBe(true)
    expect(A.org.post({ action: 'exchangeIdToken', idToken, nonceSecret: secret }).error).toContain('既に使われています')
  })
})

describe('3. メンバーの登録からログイン', () => {
  it('代表がメンバーを登録すると、そのアカウントでログインできる(一般・管理者)', () => {
    const add = (name: string, email: string, role: string) => w.call(A.org, tok.topA, 'addMember', { name, email, affiliation: '', role, sendInvite: false })
    const base = add('一般さん', 'base@a.example', 'base')
    expect(base.ok, JSON.stringify(base)).toBe(true)
    const roles = rowsOf(A.org, 'Settings').find((r) => r.key === 'roles')
    const adminRole = (JSON.parse(roles?.value || '[]') as { id: string; tier: string }[]).find((r) => r.tier === 'admin')
    expect(adminRole, '管理者の役職が初期設定にありません').toBeTruthy()
    expect(add('管理者さん', 'admin@a.example', adminRole!.id).ok).toBe(true)
    const b = w.googleLogin(A.org, 'base@a.example')
    expect(b.result.memberId).toBe(base.result.id)
    tok.baseA = b.result.session.token
    tok.adminA = w.googleLogin(A.org, 'admin@a.example').result.session.token
    expect(tok.adminA).toBeTruthy()
    // 大文字・空白の違いでもログインできる
    expect(w.googleLogin(A.org, 'BASE@a.example').result.memberId).toBe(base.result.id)
    expect(w.googleLogin(A.org, ' Base@A.example ').result.memberId).toBe(base.result.id)
  })
})

describe('4. タスクの作成・承認・完了', () => {
  let taskId = ''
  it('一般のメンバーが作ったタスクは承認待ちになり、代表が承認する', () => {
    const me = rowsOf(A.org, 'Members').find((m) => m.name === '一般さん')!
    const r = w.call(A.org, tok.baseA, 'createTasks', { tasks: [{ tempId: 'tmp-1', title: '公開前の確認', projectId: '', department: '', category: '', skills: [],
      difficulty: 'normal', priority: 'medium', deadline: null, assigneeIds: [me.id], creatorId: me.id, pendingApproval: true }] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    taskId = r.result[0].id
    expect(taskOf(A.org, taskId).approval_status).toMatch(/pending|承認待ち/)
    // 一般は承認できない
    expect(w.call(A.org, tok.baseA, 'approveTask', { taskId })).toMatchObject({ ok: false, forbidden: true })
    expect(w.call(A.org, tok.topA, 'approveTask', { taskId }).ok).toBe(true)
    expect(taskOf(A.org, taskId).approval_status).toMatch(/approved|承認済み/)
  })

  it('担当者は確認待ちにでき、完了は代表(確認する人)がする', () => {
    expect(w.call(A.org, tok.baseA, 'updateTaskStatus', { taskId, status: 'review' }).ok).toBe(true)
    expect(taskOf(A.org, taskId).status).toMatch(/review|確認待ち/)
    const self = w.call(A.org, tok.baseA, 'updateTaskStatus', { taskId, status: 'done' })
    expect(self.ok).toBe(false)
    expect(w.call(A.org, tok.topA, 'updateTaskStatus', { taskId, status: 'done' }).ok).toBe(true)
    expect(taskOf(A.org, taskId).status).toMatch(/done|完了/)
  })
})

describe('5. 団体間のデータの分離', () => {
  it('団体A のログインは、団体B の GAS では使えない', () => {
    const r = w.call(B.org, tok.topA, 'getInitialData')
    expect(r.ok).toBe(false)
    expect(r.authError).toBe(true)
  })

  it('団体B の代表には、団体A のタスク・メンバー・メールアドレスが見えない', () => {
    const a = w.call(A.org, tok.topA, 'getInitialData')
    const b = w.call(B.org, tok.topB, 'getInitialData')
    expect(taskIds(a.result).length).toBeGreaterThan(0)
    expect(taskIds(b.result)).toEqual([])
    const text = JSON.stringify(b.result)
    for (const leak of ['一般さん', '管理者さん', 'base@a.example', 'top@a.example', '公開前の確認']) expect(text).not.toContain(leak)
  })

  it('団体ごとに、署名の鍵・団体ID が違う', () => {
    expect(A.org.props.SESSION_SIGNING_KEY).not.toBe(B.org.props.SESSION_SIGNING_KEY)
    expect(A.org.props.ORG_ID).not.toBe(B.org.props.ORG_ID)
  })
})

describe('6. 一般と管理者の権限', () => {
  const daihyoOnly = [
    ['addMember', { name: 'x', email: 'x@a.example', affiliation: '', role: 'base' }],
    ['removeMember', { memberId: '1' }],
    ['updateRole', { memberId: '1', role: 'base' }],
    ['getOpsStatus', {}],
    ['getBackupStatus', {}],
    ['getDiagnostics', {}],
  ] as const
  it('一般のメンバーは、代表だけの操作・管理者の操作を使えない', () => {
    for (const [action, body] of daihyoOnly) {
      expect(w.call(A.org, tok.baseA, action, body), action).toMatchObject({ ok: false, forbidden: true })
    }
    expect(w.call(A.org, tok.baseA, 'getAnnouncements')).toMatchObject({ ok: false, forbidden: true })
    expect(w.call(A.org, tok.baseA, 'getMailQuotaStatus')).toMatchObject({ ok: false, forbidden: true })
  })

  it('管理者は管理者の操作を使えるが、代表だけの操作は使えない', () => {
    expect(w.call(A.org, tok.adminA, 'getAnnouncements').ok).toBe(true)
    expect(w.call(A.org, tok.adminA, 'getMailQuotaStatus').ok).toBe(true)
    for (const [action, body] of daihyoOnly) expect(w.call(A.org, tok.adminA, action, body), action).toMatchObject({ ok: false, forbidden: true })
  })

  it('一般のメンバーは、自分が見られないタスク(幹部限定)を初期データで受け取らない', () => {
    const r = w.call(A.org, tok.topA, 'createTasks', { tasks: [{ tempId: 'tmp-2', title: '幹部限定のタスク', projectId: '', department: '', category: '', skills: [],
      difficulty: 'normal', priority: 'medium', deadline: null, assigneeIds: [], visibility: 'leaders' }] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const base = w.call(A.org, tok.baseA, 'getInitialData')
    expect(JSON.stringify(base.result)).not.toContain('幹部限定のタスク')
    const top = w.call(A.org, tok.topA, 'getInitialData')
    expect(JSON.stringify(top.result)).toContain('幹部限定のタスク')
  })
})

describe('7. 未ログイン・ログアウトの後', () => {
  it('ログインしていない・壊れた・期限切れのセッションでは、読み取りも書き込みもできない', () => {
    expect(w.call(A.org, undefined, 'getInitialData')).toMatchObject({ ok: false, authError: true })
    expect(w.call(A.org, 'v1.broken.token', 'getInitialData')).toMatchObject({ ok: false, authError: true })
    const [v, payload, sig] = tok.baseA.split('.')
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    forged.sub = '1'
    const forgedToken = [v, Buffer.from(JSON.stringify(forged)).toString('base64url'), sig].join('.')
    expect(w.call(A.org, forgedToken, 'getInitialData')).toMatchObject({ ok: false, authError: true })
    expect(w.call(A.org, undefined, 'createTasks', { tasks: [{ tempId: 't', title: 'x' }] })).toMatchObject({ ok: false })
  })

  it('ログアウト(この端末以外も含めて無効にする)の後は、同じセッションを使えない', () => {
    expect(w.call(A.org, tok.baseA, 'getInitialData').ok).toBe(true)
    expect(w.call(A.org, tok.baseA, 'revokeMySessions').ok).toBe(true)
    expect(w.call(A.org, tok.baseA, 'getInitialData')).toMatchObject({ ok: false, authError: true })
    // もう一度ログインすれば使える
    const again = w.googleLogin(A.org, 'base@a.example')
    expect(w.call(A.org, again.result.session.token, 'getInitialData').ok).toBe(true)
  })

  it('代表がメンバーを休止にしても、そのメンバーはログインできる(ログインを止めるのは退会の時だけ)', () => {
    const base = rowsOf(A.org, 'Members').find((m) => m.name === '一般さん')!
    expect(w.call(A.org, tok.topA, 'updateMemberInactive', { memberId: base.id, inactive: true }).ok).toBe(true)
    expect(w.googleLogin(A.org, 'base@a.example').ok).toBe(true)
  })
})
