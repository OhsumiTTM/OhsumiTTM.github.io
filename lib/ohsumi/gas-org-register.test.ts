// 団体の GAS(gas/Code.gs)の R1-c: レジストリへの登録(registerWithRegistry)と、初期設定コードで
// 最初の代表が団体に入ること(exchangeIdToken の setupCode)を確かめる。
// レジストリへの通信は、テストの中でレジストリのコード(registry/Code.gs)につなぐ
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_GS, HOUR, ORG_URL, org, registry, storedKey } from './gas-org-harness'

describe('レジストリへの登録(団体の GAS)', () => {
  it('登録コードで登録し、共有鍵をスクリプトプロパティに保存する。代表がいなければ初期設定コードを作る', () => {
    const reg = registry()
    const o = org(reg)
    const code = reg.issue().code
    const out = o.register(code)
    expect(out).toMatchObject({ displayName: '新しい団体', keyGen: 1, kind: 'new' })
    expect(out.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    // 通信は1回
    expect(o.fetches()).toBe(1)
    // レジストリに登録された(団体ID・接続先)
    const orgRow = reg.sheets.get('Orgs')!.rows[1]
    expect(orgRow.slice(0, 2)).toEqual([o.props.ORG_ID, ORG_URL])
    // 共有鍵は団体の GAS のスクリプトプロパティに保存する(レジストリと同じ値)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
    expect(o.props.REGISTRY_PENDING).toBeUndefined()
    // 初期設定コードはハッシュだけを保存する(72時間)
    expect(o.props.INITIAL_SETUP_HASH).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Number(o.props.INITIAL_SETUP_EXPIRES) - Date.now()).toBeGreaterThan(71 * HOUR)
    expect(Number(o.props.INITIAL_SETUP_EXPIRES) - Date.now()).toBeLessThanOrEqual(72 * HOUR + 1000)
  })

  it('応答が失われても、同じ registerNonce で送り直し、同じ共有鍵を受け取る(二重に登録しない)', () => {
    const reg = registry()
    const o = org(reg, { lose: [1] })
    const out = o.register(reg.issue().code)
    expect(out.keyGen).toBe(1)
    expect(o.sent).toHaveLength(2)
    expect(o.sent[1].registerNonce).toBe(o.sent[0].registerNonce)
    // registerNonce は32バイトの乱数(base64url の43文字)
    expect(String(o.sent[0].registerNonce)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })

  it('3回とも応答が失われた後、メニューからやり直しても(同じ登録コード)、「使用済み」で失敗せず同じ結果になる', () => {
    const reg = registry()
    const o = org(reg, { lose: [1, 2, 3] })
    const code = reg.issue().code
    expect(() => o.register(code)).toThrow(/応答を受け取れませんでした[\s\S]*二重には登録されません/)
    expect(o.props.REGISTRY_SHARED_KEY).toBeUndefined()
    // 送る前にスクリプトプロパティに保存してある
    expect(JSON.parse(o.props.REGISTRY_PENDING).registerNonce).toBe(o.sent[0].registerNonce)
    const out = o.register(code)
    expect(out.keyGen).toBe(1)
    expect(new Set(o.sent.map((s) => s.registerNonce)).size).toBe(1)
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })

  it('使えない登録コードは、レジストリの理由をそのまま知らせる', () => {
    const reg = registry()
    const o = org(reg)
    expect(() => o.register('AAAA-BBBB-CCCC-DDDD')).toThrow(/使えなくなっています/)
    expect(o.props.REGISTRY_SHARED_KEY).toBeUndefined()
  })

  it('レジストリの URL・この GAS の URL が無い・形が違う時は、設定のしかたを知らせる', () => {
    const reg = registry()
    // コードの既定値(DEFAULT_REGISTRY_URL)も空の時
    const noUrl = org(reg, { props: { REGISTRY_URL: '' } })
    noUrl.c.DEFAULT_REGISTRY_URL = ''
    expect(() => noUrl.register('AAAA')).toThrow(/REGISTRY_URL/)
    expect(() => org(reg, { props: { OHSUMI_WEBAPP_URL: 'https://script.google.com/macros/s/X/dev' } }).register('AAAA')).toThrow(/OHSUMI_WEBAPP_URL/)
  })

  it('この GAS の URL が /dev・/u/1/・/a/macros/<ドメイン>/・? 付きの時は、レジストリに送る前に断る', () => {
    const reg = registry()
    const cases: [string, RegExp][] = [
      ['https://script.google.com/macros/s/ORGGAS/dev', /\/dev はエディタで試すための URL/],
      ['https://script.google.com/macros/u/1/s/ORGGAS/exec', /\/u\/1\/ などは、複数の Google アカウント/],
      ['https://script.google.com/macros/u/0/s/ORGGAS/dev', /レジストリに登録できない形/],
      ['https://script.google.com/a/macros/example.org/s/ORGGAS/exec', /Google Workspace のドメインの中だけ/],
      ['https://script.google.com/macros/s/ORGGAS/exec?v=1', /\? や # の後ろは付けません/],
      ['https://script.google.com/macros/s/ORGGAS/exec/', /レジストリに登録できない形/],
    ]
    for (const [url, why] of cases) {
      // スクリプトプロパティに入れた時は形を断る。ScriptApp の URL しか無い時は、形を見る前に止める(使わない)
      for (const [o, expected] of [[org(reg, { props: { OHSUMI_WEBAPP_URL: url } }), why], [org(reg, { props: { OHSUMI_WEBAPP_URL: '' }, serviceUrl: url }), /まだ分かりません/]] as const) {
        const code = reg.issue().code
        expect(() => o.register(code), url).toThrow(expected)
        expect(o.fetches(), url).toBe(0)
        expect(o.props.REGISTRY_PENDING, url).toBeUndefined()
      }
    }
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(0)
  })

  it('OHSUMI_WEBAPP_URL も、ブラウザで開いた時に覚えた URL も無い時は、getService().getUrl() を使わずに止める(メニューはコードを聞かない)', () => {
    const reg = registry()
    const o = org(reg, { props: { OHSUMI_WEBAPP_URL: '' }, serviceUrl: 'https://script.google.com/macros/s/OTHERID/exec' })
    expect(() => o.register(reg.issue().code)).toThrow(/「デプロイを管理」のウェブアプリの URL をブラウザで一度開いてから、もう一度登録してください\(利用マニュアル 3\.4\)/)
    expect(o.fetches()).toBe(0)
    expect(o.ownGets).toEqual([])
    o.menu(reg.issue().code)
    expect(o.dialogs).toHaveLength(1)
    expect(o.dialogs[0].title).toBe('登録できませんでした')
    expect(o.dialogs[0].text).toMatch(/利用マニュアル 3\.4/)
    expect(o.dialogs[0].text).not.toContain('OTHERID')
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(0)
  })

  it('ブラウザで開いた時に覚えた URL が getService().getUrl() より優先され、その URL で登録する', () => {
    const reg = registry()
    const o = org(reg, { props: { OHSUMI_WEBAPP_URL: '', DETECTED_WEBAPP_URL: ORG_URL }, serviceUrl: 'https://script.google.com/macros/s/OTHERID/exec' })
    o.register(reg.issue().code)
    expect(o.ownGets).toEqual([ORG_URL])
    expect(o.sent[0]).toMatchObject({ action: 'registerOrg', gasUrl: ORG_URL })
  })

  it('登録の前に、その URL に GET を送って doGet の応答を確かめる。返らなければ(404 など)レジストリに送らない', () => {
    const reg = registry()
    for (const ownGet of [{ code: 404, text: '<html>Sorry, unable to open the file at this time.</html>' }, { code: 200, text: '{"ok":true}' }]) {
      const o = org(reg, { ownGet })
      const code = reg.issue().code
      expect(() => o.register(code)).toThrow(new RegExp('登録する URL\\(' + ORG_URL.replace(/[.?/]/g, '\\$&') + '\\)から、この GAS の応答が返りませんでした'))
      expect(() => o.register(code)).toThrow(/登録はしていません。ブラウザでこの URL を開き/)
      expect(o.ownGets[0]).toBe(ORG_URL)
      expect(o.fetches()).toBe(0)
      expect(o.props.REGISTRY_SHARED_KEY).toBeUndefined()
    }
    // 404 の時は HTTP の状態も出す
    expect(() => org(reg, { ownGet: { code: 404, text: 'x' } }).register(reg.issue().code)).toThrow(/HTTP 404/)
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(0)
  })

  it('メニューでは、登録する URL を送る前に表示する。URL の形が違えば、コードを聞かずに止める', () => {
    const reg = registry()
    const o = org(reg)
    o.menu(reg.issue().code)
    expect(o.dialogs[0].text).toContain(ORG_URL)
    expect(o.dialogs[1].title).toBe('登録しました')
    // 招待リンクの作り方(団体ID)も出す
    expect(o.dialogs[1].text).toContain('/?org=' + o.props.ORG_ID)
    const bad = org(reg, { props: { OHSUMI_WEBAPP_URL: 'https://script.google.com/macros/s/ORGGAS/dev' } })
    bad.menu(reg.issue().code)
    expect(bad.dialogs).toHaveLength(1)
    expect(bad.dialogs[0]).toMatchObject({ title: '登録できませんでした' })
    expect(bad.fetches()).toBe(0)
  })

  it('再登録コードで、新しい共有鍵に入れ替わる(代表がいれば初期設定コードは作らない)', () => {
    const reg = registry()
    const o = org(reg, { members: [['id', 'name', 'role'], ['1', '代表', 'top']] })
    const first = o.register(reg.issue().code)
    expect(first.setupCode).toBeUndefined()
    const key1 = o.props.REGISTRY_SHARED_KEY
    const re = reg.issue({ kind: 'reissue', targetOrgId: o.props.ORG_ID })
    const second = o.register(re.code)
    expect(second).toMatchObject({ kind: 'reissue', keyGen: 2 })
    expect(o.props.REGISTRY_SHARED_KEY).not.toBe(key1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })
})

describe('初期設定コードで最初の代表が入る', () => {
  const started = () => {
    const reg = registry()
    const o = org(reg)
    const out = o.register(reg.issue().code)
    return { reg, o, setupCode: String(out.setupCode) }
  }

  it('未登録のアカウントが初期設定コードを付けてログインすると、代表として登録され、そのままログインできる(通信1回)', () => {
    const { o, setupCode } = started()
    const res = o.login('first@example.org', setupCode.toLowerCase())
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.session.token).toBe('session-100')
    expect(o.added).toEqual([{ id: '100', name: 'first', email: 'first@example.org', role: 'top' }])
    expect(o.props.INITIAL_SETUP_HASH).toBeUndefined()
  })

  it('初期設定コードは1回だけ使える', () => {
    const { o, setupCode } = started()
    expect(o.login('first@example.org', setupCode).ok).toBe(true)
    const second = o.login('second@example.org', setupCode)
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/使えなくなっています/)
    expect(o.added).toHaveLength(1)
  })

  it('72時間を過ぎたら使えない', () => {
    const reg = registry()
    const o = org(reg)
    const out = o.register(reg.issue().code, Date.now() - 73 * HOUR)
    const res = o.login('first@example.org', String(out.setupCode))
    expect(res.ok).toBe(false)
    expect(o.added).toEqual([])
  })

  it('コードの間違いが10回続いたら、正しいコードも使えなくなる(メニューで作り直す)', () => {
    const { o, setupCode } = started()
    for (let i = 0; i < 9; i++) expect(o.login('x@example.org', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ').error).toMatch(/正しくない/)
    expect(o.login('x@example.org', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ').error).toMatch(/間違いが続いた/)
    expect(o.login('first@example.org', setupCode).ok).toBe(false)
    expect(o.added).toEqual([])
  })

  it('既に代表がいる団体では使えない', () => {
    const { o, setupCode } = started()
    o.members.push(['9', '代表', 'top'])
    expect(o.login('first@example.org', setupCode).error).toMatch(/既に代表がいます/)
    expect(o.added).toEqual([])
  })

  it('初期設定コードを付けないログインは、これまでどおり「登録されていない」を返す', () => {
    const { o } = started()
    expect(o.login('someone@example.org').result).toMatchObject({ memberId: null, email: 'someone@example.org' })
  })
})

describe('すでにメンバーと代表がいる団体の登録', () => {
  // 動いている団体: 代表・メンバーがいて、ログインの設定(団体ID・署名鍵・ログアウトの世代)がある
  const running = () => {
    const reg = registry()
    const before: Record<string, string> = {
      ORG_ID: 'org_RUNNINGRUNNINGRUN1', SESSION_SIGNING_KEY: 'signing-key-existing', SESSION_KEY_ID: 'kid00001', SESSION_GEN_m2: '3',
    }
    const members = [['id', 'name', 'role'], ['m1', '代表さん', '代表'], ['m2', 'メンバー', 'base']]
    const o = org(reg, { members, props: before, emails: { 'daihyo@example.org': 'm1', 'member@example.org': 'm2' } })
    return { reg, o, before, members: members.map((r) => r.slice()) }
  }

  it('登録しても、初期設定コードは作らず、団体ID・ログインの鍵・メンバーは変わらない', () => {
    const { reg, o, before, members } = running()
    const out = o.register(reg.issue().code)
    expect(out.setupCode).toBeUndefined()
    expect(Object.keys(o.props).filter((k) => k.startsWith('INITIAL_SETUP_'))).toEqual([])
    for (const [k, v] of Object.entries(before)) expect(o.props[k], k).toBe(v)
    expect(o.members).toEqual(members)
    expect(o.added).toEqual([])
    // レジストリには、今の団体ID で登録される
    expect(reg.sheets.get('Orgs')!.rows[1].slice(0, 2)).toEqual([before.ORG_ID, ORG_URL])
    // 登録で増えるスクリプトプロパティは、共有鍵まわりだけ
    expect(Object.keys(o.props).filter((k) => !(k in before)).sort()).toEqual(
      ['GOOGLE_OAUTH_CLIENT_ID', 'OHSUMI_WEBAPP_URL', 'REGISTRY_KEY_GEN', 'REGISTRY_REGISTERED_AT', 'REGISTRY_SHARED_KEY', 'REGISTRY_URL'])
  })

  it('今の代表・メンバーは、これまでどおりログインできる(初期設定コードを付けて来ても、代表にならず今のメンバーのまま)', () => {
    const { reg, o } = running()
    o.register(reg.issue().code)
    expect(o.login('daihyo@example.org').result.session.token).toBe('session-m1')
    expect(o.login('member@example.org').result.session.token).toBe('session-m2')
    expect(o.login('member@example.org', 'AAAA-BBBB-CCCC-DDDD').result.session.token).toBe('session-m2')
    expect(o.added).toEqual([])
  })

  it('メンバーでない人が初期設定コードらしきものを付けて来ても、団体に入れない(コードが作られていない)', () => {
    const { reg, o, members } = running()
    o.register(reg.issue().code)
    const res = o.login('stranger@example.org', 'AAAA-BBBB-CCCC-DDDD')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/使えなくなっています/)
    expect(o.members).toEqual(members)
    expect(o.login('stranger@example.org').result).toMatchObject({ memberId: null, email: 'stranger@example.org' })
  })

  it('「初期設定コードを作り直す」も、代表がいる団体では作らない', () => {
    const { reg, o } = running()
    o.register(reg.issue().code)
    ;(o.gas.regenerateInitialSetupCodeFromMenu as () => void)()
    expect(o.dialogs.at(-1)!.text).toMatch(/既に代表がいます/)
    expect(Object.keys(o.props).filter((k) => k.startsWith('INITIAL_SETUP_'))).toEqual([])
  })
})

describe('共有鍵・初期設定コードを残さない', () => {
  it('実行ログ・レジストリの操作の記録に、共有鍵・登録コード・初期設定コードが元の形で出ない', () => {
    const reg = registry()
    const o = org(reg)
    const code = reg.issue().code
    const out = o.register(code)
    o.login('first@example.org', String(out.setupCode))
    const secrets = [o.props.REGISTRY_SHARED_KEY, code, code.replace(/-/g, ''), String(out.setupCode), String(out.setupCode).replace(/-/g, '')]
    const places = {
      orgLogs: o.logs.join('\n'),
      registryLogs: reg.logs.join('\n'),
      audit: JSON.stringify(reg.sheets.get('AuditLog')!.rows),
      orgProps: JSON.stringify({ ...o.props, REGISTRY_SHARED_KEY: '' }),
    }
    for (const [where, text] of Object.entries(places)) for (const s of secrets) expect(text, where).not.toContain(s)
  })

  it('メニューの関数は、初期設定コードをダイアログにだけ出す(実行ログには出さない)', () => {
    const src = CODE_GS.slice(CODE_GS.indexOf('function registerWithRegistryFromMenu('), CODE_GS.indexOf('\nfunction ', CODE_GS.indexOf('function regenerateInitialSetupCodeFromMenu(') + 10))
    expect(src).toContain('showMenuResultDialog_(')
    expect(src).not.toMatch(/console\.|Logger\./)
    const dialog = CODE_GS.slice(CODE_GS.indexOf('function inviteLinkSection_('), CODE_GS.indexOf('\nfunction ', CODE_GS.indexOf('function showMenuResultDialog_(') + 10))
    expect(dialog).not.toMatch(/console\.|Logger\.|setProperty|appendRow|setValue/)
  })
})

describe('登録の後のダイアログ(コピーできる形)', () => {
  // レジストリに確かめてサイトの URL が分かった時の招待リンク(確かめ方そのものは gas-entry-links.test.ts)
  const withSite = (o: ReturnType<typeof org>) => {
    o.c.setupInviteLink_ = () => 'https://site.example/?org=' + encodeURIComponent(String(o.props.ORG_ID))
    return o
  }

  it('登録の結果は、招待リンク・初期設定コード・次にやることを、見出しを分けて、コピーできる欄に出す', () => {
    const reg = registry()
    const o = withSite(org(reg))
    o.menu(reg.issue().code)
    const d = o.dialogs[1]
    expect(d.title).toBe('登録しました')
    expect(d.sections!.map((s) => s.heading)).toEqual(['① 招待リンク', '② 初期設定コード', '③ 次にやること'])
    // 招待リンクは、コピーの欄と、新しいタブで開くリンク
    const invite = d.sections![0]
    expect(invite.value).toContain('/?org=' + o.props.ORG_ID)
    expect(invite.link).toBe(true)
    expect(d.html).toContain('target="_blank"')
    expect(invite.notes.join('\n')).toContain('「Ohsumi」→「招待リンクを表示」')
    // 初期設定コード: 有効期限と、作り直し方
    const code = d.sections![1]
    expect(code.value).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/)
    expect(code.link).toBe(false)
    expect(code.notes.join('\n')).toMatch(/72時間・1回限り/)
    expect(code.notes.join('\n')).toContain('「初期設定コードを作り直す」で作り直せます')
    // コピーボタン(値の欄ごと)と、使えない時の案内
    expect((d.html!.match(/class="copy"/g) ?? []).length).toBe(2)
    expect(d.html).toContain('Ctrl+C(Mac は ⌘+C)')
    // 初期設定コードは、ダイアログにだけ出す(ログ・プロパティに元の形で残らない)
    expect(o.logs.join('\n')).not.toContain(code.value)
    expect(JSON.stringify(o.props)).not.toContain(code.value)
  })

  it('ダイアログに出す値は、HTML の文字としてエスケープする(テンプレートは <?!= ?> を使わない)', () => {
    const html = CODE_GS.slice(CODE_GS.indexOf('function menuResultDialogHtml_('), CODE_GS.indexOf('function showMenuResultDialog_('))
    expect(html).not.toContain('<?!=')
    const reg = registry()
    const o = org(reg)
    const bad = '<img src=x onerror=alert(1)>"\'&'
    ;(o.gas.showMenuResultDialog_ as (t: string, i: string, s: object[]) => void)('t', bad, [{ heading: bad, value: bad, link: true, notes: [bad] }])
    const d = o.dialogs.at(-1)!
    expect(d.html).not.toContain('<img')
    expect(d.html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;')
    // https で始まらない値は、リンクにしない
    expect(d.sections![0].link).toBe(false)
    expect(d.html).not.toContain('href=')
    // javascript: もリンクにしない
    ;(o.gas.showMenuResultDialog_ as (t: string, i: string, s: object[]) => void)('t', '', [{ heading: 'h', value: 'javascript:alert(1)', link: true, notes: [] }])
    expect(o.dialogs.at(-1)!.html).not.toContain('href=')
  })

  it('「招待リンクを表示」: 登録の前は、先に登録するよう知らせる。登録の後は、いつでも招待リンクだけを出す', () => {
    const reg = registry()
    const o = withSite(org(reg))
    ;(o.gas.showInviteLinkFromMenu as () => void)()
    expect(o.dialogs.at(-1)).toMatchObject({ title: '招待リンク', text: '先に「レジストリに登録する…」で登録してください。' })
    o.register(reg.issue().code)
    ;(o.gas.showInviteLinkFromMenu as () => void)()
    const d = o.dialogs.at(-1)!
    expect(d.title).toBe('招待リンク')
    expect(d.sections!).toHaveLength(1)
    expect(d.sections![0].value).toContain('/?org=' + o.props.ORG_ID)
    // 秘密の値(共有鍵)は含まない
    expect(d.html).not.toContain(o.props.REGISTRY_SHARED_KEY)
  })

  it('サイトの URL が分からない時は、招待リンクの欄を出さず、作り方と、もう一度出す方法を書く', () => {
    const reg = registry()
    const o = org(reg)
    o.c.setupInviteLink_ = () => ''
    o.menu(reg.issue().code)
    const invite = o.dialogs[1].sections![0]
    expect(invite.value).toBe('')
    expect(invite.notes.join('\n')).toContain('/?org=' + o.props.ORG_ID)
    expect(invite.notes.join('\n')).toContain('「招待リンクを表示」')
  })

  it('「初期設定コードを作り直す」も、コピーできるダイアログで出す', () => {
    const reg = registry()
    const o = org(reg)
    o.register(reg.issue().code)
    ;(o.gas.regenerateInitialSetupCodeFromMenu as () => void)()
    const d = o.dialogs.at(-1)!
    expect(d.title).toBe('初期設定コードを作り直しました')
    expect(d.text).toContain('前のコードは使えなくなりました。')
    expect(d.sections![0].value).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/)
    expect(d.html).toContain('class="copy"')
  })

  it('メニューに「招待リンクを表示」がある。HtmlService のために権限(スコープ)は増えない', () => {
    expect(CODE_GS).toContain(".addItem('招待リンクを表示', 'showInviteLinkFromMenu')")
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'gas', 'appsscript.json'), 'utf8')) as { oauthScopes: string[] }
    // ダイアログ(showModalDialog)に要るのは script.container.ui だけで、ui.alert と同じ(前から入っている)
    expect(manifest.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/script.send_mail',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.container.ui',
      'https://www.googleapis.com/auth/userinfo.email',
    ])
  })
})
