// 画面の中で作った QR コードが、招待リンクとして読み取れることを確かめる(読み取りは jsQR。テストでだけ使う)
import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { inviteLink } from './org-directory'
import { qrMatrix, qrSvgPath } from './qr'

// path を、1マス scale ピクセルの白黒の画像にする(SVG の描き方と同じ手順で塗る)
function rasterize(d: string, size: number, scale = 4) {
  const px = size * scale
  const data = new Uint8ClampedArray(px * px * 4).fill(255)
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])]
    for (let yy = y * scale; yy < (y + 1) * scale; yy++) {
      for (let xx = x * scale; xx < (x + w) * scale; xx++) {
        const i = (yy * px + xx) * 4
        data[i] = data[i + 1] = data[i + 2] = 0
      }
    }
  }
  return { data, px }
}

describe('QR コード', () => {
  it.each([
    'https://example.com/?org=org_ABCDEFGHIJKLMNOP',
    inviteLink('https://ohsumi.example.org', '', 'org_' + 'x'.repeat(64)),
    inviteLink('http://127.0.0.1:3000', '', 'org_LAYOUTLAYOUTLAYOUT01'),
  ])('%s を読み取れる', (link) => {
    const { d, size } = qrSvgPath(qrMatrix(link))
    const { data, px } = rasterize(d, size)
    expect(jsQR(data, px, px)?.data).toBe(link)
  })

  it('周りに4マスの余白を取り、正方形にする', () => {
    const m = qrMatrix('https://example.com/?org=org_ABCDEFGHIJKLMNOP')
    expect(m.every((row) => row.length === m.length)).toBe(true)
    expect(qrSvgPath(m).size).toBe(m.length + 8)
    expect(qrSvgPath(m).d.startsWith('M4 4h7')).toBe(true)
  })
})
