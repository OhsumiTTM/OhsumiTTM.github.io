// QR コードを画面の中で作る(外部のサービスに URL を送らない)。
// qrcode-generator でモジュール(黒白のマス)を作り、SVG の path にする(<svg> の要素なので CSP を変えなくてよい。
// data: の画像やインラインの style は使わない)
import qrcode from 'qrcode-generator'

/** 黒いマスなら true の2次元配列(周りの余白は含まない) */
export function qrMatrix(text: string): boolean[][] {
  // 誤り訂正は M(約15%)。型番は自動(URL の長さに合わせる)
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
}

/** SVG の path(1マス = 1単位。margin マスの余白を足した座標)。viewBox は 0 0 size size */
export function qrSvgPath(matrix: boolean[][], margin = 4): { d: string; size: number } {
  const n = matrix.length
  let d = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue
      // 横に続く黒いマスは1つの四角にまとめる
      let w = 1
      while (c + w < n && matrix[r][c + w]) w++
      d += `M${c + margin} ${r + margin}h${w}v1h-${w}z`
      c += w - 1
    }
  }
  return { d, size: n + margin * 2 }
}
