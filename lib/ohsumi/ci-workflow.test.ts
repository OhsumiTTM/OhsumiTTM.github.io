// CI(.github/workflows/ci.yml)が動く条件を固定する。
// 積んだ PR の向き先を main に変えた時にも動き、題名・説明だけの変更では動かない
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CI = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')

describe('CI が動く条件', () => {
  it('main 向けの PR で、作成・push・再オープン・編集(向き先の変更)の時に動く', () => {
    expect(CI).toMatch(/pull_request:\n\s+branches: \[main\]\n(\s+#.*\n)*\s+types: \[opened, synchronize, reopened, edited\]/)
  })

  it('編集のうち、向き先を変えた時だけ実行する(題名・説明だけの変更では実行しない)', () => {
    expect(CI).toMatch(/\n  check:\n\s+if: github\.event\.action != 'edited' \|\| github\.event\.changes\.base\n/)
  })

  it('題名・説明だけの変更は別のグループにして、実行中の CI を止めない', () => {
    expect(CI).toMatch(
      /group: ci-\$\{\{ github\.event\.pull_request\.number \}\}\$\{\{ github\.event\.action == 'edited' && !github\.event\.changes\.base && '-edited' \|\| '' \}\}/,
    )
    expect(CI).toMatch(/cancel-in-progress: true/)
  })
})
