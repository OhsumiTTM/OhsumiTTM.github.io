// ブラウザのタブのアイコン(app/favicon.ico)と、ホーム画面に追加した時のアイコン(app/apple-icon.png・public/icons/*.png)を、
// ロゴのシンボル(app/icon.svg)だけの形で作り直す。ヘッドレスの Chrome で SVG を描き、PNG にする(ブランドを変えた時に実行する)。
//   node scripts/brand-icons.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const SYMBOL = readFileSync(join(ROOT, 'app', 'icon.svg'), 'utf8')
const OFF_WHITE = '#F6F8FC'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  for (const c of [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) if (c && existsSync(c)) return c
  throw new Error('Chrome が見つかりません(CHROME_PATH で指定してください)')
}

// size: 画像の大きさ / pad: 余白(大きさに対する割合)/ bg: 背景(null は透明)
function page(size, pad, bg) {
  const inner = Math.round(size * (1 - pad * 2))
  const svg = SYMBOL.replace(/width="\d+" height="\d+"/, `width="${inner}" height="${inner}"`)
  return `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${bg ?? 'transparent'}">${svg}</body></html>`
}

async function main() {
  const port = 9700 + Math.floor(Math.random() * 100)
  const chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
  let targets = []
  for (let i = 0; i < 100 && !targets.some((t) => t.type === 'page'); i++) {
    await sleep(200)
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { /* 起動中 */ }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id) } }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  const render = async (size, pad, bg) => {
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(page(size, pad, bg)).toString('base64') })
    await sleep(400)
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } })
    return Buffer.from(shot.data, 'base64')
  }
  // タブのアイコン: 透明の背景に、シンボルだけ(16・32・48px を1つの .ico に入れる)
  const ico = [16, 32, 48]
  const pngs = []
  for (const s of ico) pngs.push(await render(s, 0.02, null))
  writeFileSync(join(ROOT, 'app', 'favicon.ico'), toIco(ico, pngs))
  // ホーム画面のアイコン: iOS は透明の部分を黒にするので、Off White の背景にシンボル(四隅は OS が丸める)
  writeFileSync(join(ROOT, 'app', 'apple-icon.png'), await render(180, 0.16, OFF_WHITE))
  mkdirSync(join(ROOT, 'public', 'icons'), { recursive: true })
  for (const s of [192, 512]) writeFileSync(join(ROOT, 'public', 'icons', `icon-${s}.png`), await render(s, 0.16, OFF_WHITE))
  // Android の「アダプティブ アイコン」(円などに切り抜かれる)用: 余白を広く取る
  writeFileSync(join(ROOT, 'public', 'icons', 'icon-maskable-512.png'), await render(512, 0.24, OFF_WHITE))
  ws.close()
  chrome.kill()
  console.log('アイコンを作り直しました: app/favicon.ico・app/apple-icon.png・public/icons/')
}

// PNG を入れた .ico(Windows のアイコンの形式)
function toIco(sizes, pngs) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  pngs.forEach((png, i) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(sizes[i] % 256, 0); e.writeUInt8(sizes[i] % 256, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  })
  return Buffer.concat([head, ...entries, ...pngs])
}

main().catch((e) => { console.error(e); process.exit(1) })
