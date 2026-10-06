// 画面の操作と capability の対応表(lib/ohsumi/capabilities.ts の STORE_ACTION_CAPABILITIES)。
// 1. store の関数が送る GAS の操作から作った対応と、表が同じこと(表の書き漏れ・まとまりの違いが無い)
// 2. 画面のファイルが表の関数を使う時は、同じファイルで can('まとまり') を確かめていること
//    = GAS が断る操作の部品が、そのまとまりの無い人に出ないこと(出し分けの中身は e2e でも確かめる)
// 3. 「代表だけ」「全権管理者だけ」の古い判定(AdminAccessNote・isDaihyo)で操作を出し分けていないこと
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_ACTIONS, STORE_ACTION_CAPABILITIES, type Capability } from './capabilities'
import { READ_SAFE_STORE_FUNCTIONS } from './read-only'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ACTION_CAPABILITY = new Map<string, Capability>(
  (Object.entries(CAPABILITY_ACTIONS) as [Capability, readonly string[]][]).flatMap(([cap, actions]) => actions.map((a) => [a, cap] as const)),
)

// remoteApi の関数 → GAS の操作(postToGas の1つ目の引数)
function remoteActions(): Map<string, string> {
  const src = read('lib/ohsumi/remote.ts')
  const out = new Map<string, string>()
  for (const m of src.matchAll(/\n {2}(\w+): (?:async )?\((?:[^()]|\([^()]*\))*\)[^=\n]*=>\s*(?:\n\s*)?postToGas(?:<[^>]*>)?\(\s*'(\w+)'/g)) out.set(m[1], m[2])
  return out
}

// store の関数 → まとまり(GAS の操作を直接送るものと、それを呼ぶもの)
function deriveStoreTable(): Record<string, Capability> {
  const rmap = remoteActions()
  const src = read('lib/ohsumi/store.tsx')
  const parts = src.split(/\n {2}const (\w+) = /)
  const bodies = new Map<string, string>()
  for (let i = 1; i < parts.length; i += 2) bodies.set(parts[i], parts[i + 1])
  const caps = new Map<string, Set<Capability>>()
  for (const [name, body] of bodies) {
    for (const m of body.matchAll(/remoteApi\s*\.\s*(\w+)\(/g)) {
      const cap = ACTION_CAPABILITY.get(rmap.get(m[1]) ?? m[1])
      if (cap) caps.set(name, new Set([...(caps.get(name) ?? []), cap]))
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, body] of bodies) {
      for (const [other, c] of [...caps]) {
        if (other === name || !new RegExp(`(?<![\\w.])${other}\\(`).test(body)) continue
        const cur = caps.get(name) ?? new Set<Capability>()
        const before = cur.size
        c.forEach((x) => cur.add(x))
        caps.set(name, cur)
        if (cur.size !== before) changed = true
      }
    }
  }
  return Object.fromEntries([...caps].map(([k, v]) => {
    expect(v.size, `${k} は1つのまとまりの操作だけを送る`).toBe(1)
    return [k, [...v][0]]
  }))
}

function componentFiles(dir = join(ROOT, 'components')): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return componentFiles(p)
    return p.endsWith('.tsx') ? [p] : []
  })
}

// useOhsumi() から取り出した名前(別名を付けたものは元の名前)
function storeNamesUsed(src: string): string[] {
  const names: string[] = []
  for (const m of src.matchAll(/const \{([^}]*)\} = useOhsumi\(\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':')[0].trim()
      if (name) names.push(name)
    }
  }
  return names
}

describe('画面の操作と capability の対応表', () => {
  it('store の関数が送る GAS の操作から作った対応と同じ(書き漏れ・違いが無い)', () => {
    const derived = deriveStoreTable()
    expect(Object.keys(derived).length).toBeGreaterThan(60)
    expect(Object.fromEntries(Object.entries(STORE_ACTION_CAPABILITIES).sort())).toEqual(Object.fromEntries(Object.entries(derived).sort()))
  })

  it('表の関数を使う画面のファイルは、同じファイルで can(まとまり) を確かめている', () => {
    const missing: string[] = []
    let checked = 0
    for (const file of componentFiles()) {
      const src = readFileSync(file, 'utf8')
      const needed = new Set<Capability>()
      for (const name of storeNamesUsed(src)) {
        const cap = STORE_ACTION_CAPABILITIES[name]
        if (cap) needed.add(cap)
      }
      // 画面から remoteApi を直接呼ぶ操作も同じ
      const rmap = remoteActions()
      for (const m of src.matchAll(/remoteApi\s*\.\s*(\w+)\(/g)) {
        const cap = ACTION_CAPABILITY.get(rmap.get(m[1]) ?? m[1])
        if (cap) needed.add(cap)
      }
      for (const cap of needed) {
        checked++
        const rel = file.slice(ROOT.length + 1)
        if (src.includes(`can('${cap}')`) || src.includes(`cap="${cap}"`)) continue
        // 親の画面で can を確かめてから出す部品(GAS の版・メールの上限の知らせ)
        if (/admin\/(gas-update|mail-quota)-banner\.tsx$/.test(rel)) {
          const name = rel.includes('gas-update') ? 'GasUpdateBanner' : 'MailQuotaBanner'
          if (read('components/ohsumi/admin/admin-screen.tsx').includes(`{can('${cap}') && <${name} />}`)) continue
        }
        missing.push(`${rel}: ${cap}`)
      }
    }
    expect(checked).toBeGreaterThan(20)
    expect(missing).toEqual([])
  })

  it('「代表だけ」「全権管理者だけ」の古い注記・判定で操作を出し分けていない', () => {
    for (const file of componentFiles()) {
      const src = readFileSync(file, 'utf8')
      const rel = file.slice(ROOT.length + 1)
      expect(src, rel).not.toMatch(/AdminAccessNote|admin\.accessNote\.(daihyo|fullAdmin)/)
      // isDaihyo が残ってよいのは、どの設定でも渡さない代表だけの操作(権限の例外の編集・バックアップなど)だけ
      if (/\bisDaihyo\b/.test(src)) expect(['components/ohsumi/admin/admin-permission-overrides.tsx', 'components/ohsumi/org-settings-screen.tsx'], rel).toContain(rel)
    }
  })

  it('data-gas-action に書いた操作は、GAS の操作の名前(まとまりの操作か、代表だけの操作)', () => {
    const top = ['updatePermissionOverrides']
    for (const file of componentFiles()) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/data-gas-action=(?:"(\w+)"|\{[^}]*?'(\w+)'[^}]*\})/g)) {
        const action = m[1] ?? m[2]
        expect(ACTION_CAPABILITY.has(action) || top.includes(action), `${file}: ${action}`).toBe(true)
      }
    }
  })

  it('can・roleCapabilitiesOf は、機能停止中(読み取り専用)にも画面を描く時に呼べる(書き込みとして止めない)', () => {
    // 止めると、描くたびに「保存できません」の知らせを出し直して、描き直しが止まらなくなる
    expect(READ_SAFE_STORE_FUNCTIONS.has('can')).toBe(true)
    expect(READ_SAFE_STORE_FUNCTIONS.has('roleCapabilitiesOf')).toBe(true)
  })
})
