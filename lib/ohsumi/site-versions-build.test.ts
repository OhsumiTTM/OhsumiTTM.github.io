// 版の画面を作るコミットの決め方(scripts/build-site-versions.mjs)
import { describe, expect, it } from 'vitest'
import { compareVersions, parseReleaseLog, screenCommits } from '../../scripts/build-site-versions.mjs'

const LOG = [
  '@c1 c0', '', 'gas/releases/2026.10.12-2/Code.gs',
  '@c2 c1x', '', 'gas/releases/2026.10.19-1/Code.gs',
  '@c3 c2x', '', 'gas/releases/2026.11.01-1/Code.gs', 'gas/releases/README.md',
  '@c4 c3x', '', 'gas/releases/2026.11.15-1/Code.gs',
].join('\n')

describe('版の画面のコミット', () => {
  it('git log を読む(版の Code.gs を足したコミットだけ)', () => {
    expect(parseReleaseLog(LOG)).toEqual([
      { commit: 'c1', parent: 'c0', versions: ['2026.10.12-2'] },
      { commit: 'c2', parent: 'c1x', versions: ['2026.10.19-1'] },
      { commit: 'c3', parent: 'c2x', versions: ['2026.11.01-1'] },
      { commit: 'c4', parent: 'c3x', versions: ['2026.11.15-1'] },
    ])
  })

  it('一番新しい版は作らない(main と同じ)。古い版は、次の版を足したコミットの1つ前', () => {
    const events = parseReleaseLog(LOG)
    expect(screenCommits(['2026.10.19-1', '2026.11.01-1', '2026.11.15-1'], events)).toEqual([
      { version: '2026.11.01-1', commit: 'c3x' },
      { version: '2026.10.19-1', commit: 'c2x' },
    ])
  })

  it('間の版をサイトから外していても、次に足した版の1つ前(外した版を足した時点で固定)', () => {
    const events = parseReleaseLog(LOG)
    expect(screenCommits(['2026.10.12-2', '2026.11.15-1'], events)).toEqual([{ version: '2026.10.12-2', commit: 'c1x' }])
  })

  it('足した記録が無い版(履歴が浅い)はコミットを空にする。形の違うフォルダは無視する', () => {
    expect(screenCommits(['2026.12.01-1', '2026.11.15-1', 'tmp'], parseReleaseLog(LOG))).toEqual([{ version: '2026.11.15-1', commit: '' }])
  })

  it('版の比べ方(同じ日の -2 は -1 より新しい・-10 は -9 より新しい)', () => {
    expect(compareVersions('2026.10.12-2', '2026.10.12-1')).toBeGreaterThan(0)
    expect(compareVersions('2026.10.12-10', '2026.10.12-9')).toBeGreaterThan(0)
    expect(compareVersions('2026.10.11-3', '2026.10.12-1')).toBeLessThan(0)
  })
})
