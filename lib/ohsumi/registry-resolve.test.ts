// レジストリ(registry/Code.gs)の R1-d: 接続先の解決(resolveOrg)を確かめる
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const URL_A2 = 'https://script.google.com/macros/s/AKfyA2/exec'
const NONCE = (n: number) => `register-nonce-${String(n).padStart(8, '0')}-abcdefghijklmnopqrstu`

function ready() {
  const secret = 'nonce-secret-a1-0123456789'
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(Math.floor(Date.now() / 1000) + 3600), iat: String(Math.floor(Date.now() / 1000)),
      nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const issue = (extra: Record<string, unknown> = {}) => t.post({ action: 'issueRegistrationCode', session, orgName: 'テスト団体A', ...extra }).result
  const resolve = (orgId: string) => t.post({ action: 'resolveOrg', orgId })
  const orgsRow = () => t.sheets.get('Orgs')!.rows.find((r) => r[0] === ORG_A)!
  const header = (name: string) => (t.sheets.get('Orgs')!.rows[0] as string[]).indexOf(name)
  return { ...t, session, issue, resolve, orgsRow, header }
}

function registered() {
  const t = ready()
  expect(t.post({ action: 'registerOrg', code: t.issue().code, orgId: ORG_A, gasUrl: URL_A, registerNonce: NONCE(1) }).ok).toBe(true)
  return t
}

describe('接続先の解決(resolveOrg)', () => {
  it('団体ID が一致すれば、団体の GAS の URL・状態・チャンネル・確かめた時刻・保存してよい秒数だけを返す', () => {
    const t = registered()
    const res = t.resolve(ORG_A)
    expect(res.ok).toBe(true)
    expect(Object.keys(res.result).sort()).toEqual(['channel', 'checkedAt', 'gasUrl', 'maxAgeSec', 'orgId', 'status'])
    expect(res.result).toMatchObject({ orgId: ORG_A, gasUrl: URL_A, status: 'active', channel: 'standard', maxAgeSec: 86400 })
    expect(Date.parse(res.result.checkedAt)).toBeGreaterThan(0)
    // 団体名・担当者・共有鍵は返さない
    const text = JSON.stringify(res)
    expect(text).not.toContain('テスト団体A')
    expect(text).not.toContain(String(t.sheets.get('Secrets')!.rows[1][1]).replace(/^'/, ''))
  })

  it('無い団体ID・形の違う ID・前後が違う ID は、同じ「見つかりません」を返す(一覧・検索はできない)', () => {
    const t = registered()
    const answers = ['org_BBBBBBBBBBBBBBBBBBBB', 'org_short', '', ORG_A + 'x', ORG_A.toLowerCase(), 'org_%', { toString: () => ORG_A }]
      .map((orgId) => t.resolve(orgId as string))
    for (const a of answers) {
      expect(a.ok).toBe(false)
      expect(a.notFound).toBe(true)
      expect(a.error).toBe(answers[0].error)
    }
  })

  it('停止中の団体は、status: suspended だけを返す(接続先は返さない)。停止の予定日時を過ぎた団体も同じ', () => {
    const t = registered()
    const row = t.orgsRow()
    row[t.header('status')] = 'suspended'
    t.cache.clear()
    expect(t.resolve(ORG_A).result).toMatchObject({ status: 'suspended', gasUrl: '' })
    row[t.header('status')] = 'active'
    row[t.header('suspend_at')] = new Date(Date.now() - 60_000).toISOString()
    t.cache.clear()
    expect(t.resolve(ORG_A).result).toMatchObject({ status: 'suspended', gasUrl: '' })
    // 停止の予定がまだ先なら、使える
    row[t.header('suspend_at')] = new Date(Date.now() + 86400_000).toISOString()
    t.cache.clear()
    expect(t.resolve(ORG_A).result).toMatchObject({ status: 'active', gasUrl: URL_A })
  })

  it('答えを10分覚えて、シートを読まない。無い団体は1分だけ覚える', () => {
    const t = registered()
    expect(t.resolve(ORG_A).result.gasUrl).toBe(URL_A)
    expect(t.cacheTtl.get('ro:' + ORG_A)).toBe(600)
    // シートを直接書き換えても、覚えている間は前の答え
    t.orgsRow()[t.header('gas_url')] = URL_A2
    expect(t.resolve(ORG_A).result.gasUrl).toBe(URL_A)
    t.resolve('org_BBBBBBBBBBBBBBBBBBBB')
    expect(t.cacheTtl.get('ro:org_BBBBBBBBBBBBBBBBBBBB')).toBe(60)
  })

  it('再登録(接続先の変更)の時は覚えた答えを消し、次の問い合わせから新しい接続先を返す', () => {
    const t = registered()
    expect(t.resolve(ORG_A).result.gasUrl).toBe(URL_A)
    const re = t.issue({ kind: 'reissue', targetOrgId: ORG_A })
    expect(t.post({ action: 'registerOrg', code: re.code, orgId: ORG_A, gasUrl: URL_A2, registerNonce: NONCE(2) }).ok).toBe(true)
    expect(t.resolve(ORG_A).result.gasUrl).toBe(URL_A2)
  })

  it('登録の前に「見つかりません」と覚えていても、登録した時に消す', () => {
    const t = ready()
    expect(t.resolve(ORG_A).notFound).toBe(true)
    expect(t.post({ action: 'registerOrg', code: t.issue().code, orgId: ORG_A, gasUrl: URL_A, registerNonce: NONCE(1) }).ok).toBe(true)
    expect(t.resolve(ORG_A).result.gasUrl).toBe(URL_A)
  })

  it('問い合わせは1分に120回まで(レジストリ全体)。超えたら後で送り直すよう返す', () => {
    const t = registered()
    for (let i = 0; i < 120; i++) expect(t.resolve(ORG_A).ok).toBe(true)
    expect(t.resolve(ORG_A)).toMatchObject({ ok: false, retryLater: true })
  })
})
