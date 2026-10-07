import { describe, expect, it } from 'vitest'
import { notifyFrequencyOf, toggleNotifyFrequency } from './notify-frequency'

describe('メールの頻度の表示と切り替え', () => {
  it('まだ選んでいない種類は「その都度」(GAS が送る頻度と同じ)', () => {
    expect(notifyFrequencyOf(undefined, 'new_task')).toBe('immediate')
    expect(notifyFrequencyOf({}, 'review')).toBe('immediate')
    expect(notifyFrequencyOf({ review: '1d' }, 'review')).toBe('1d')
    expect(notifyFrequencyOf({ review: 'none' }, 'review')).toBe('none')
  })

  it('選んでいる頻度をもう一度押すと「送らない」。未設定で「その都度」を押した時も同じ', () => {
    expect(toggleNotifyFrequency({}, 'review', 'immediate')).toEqual({ review: 'none' })
    expect(toggleNotifyFrequency({ review: '3h' }, 'review', '3h')).toEqual({ review: 'none' })
  })

  it('ほかの頻度を押すとそれに変わり、ほかの種類・ベルの設定は残る', () => {
    const bell = { mention: false }
    expect(toggleNotifyFrequency({ mention: '6h', bell }, 'review', '1d')).toEqual({ mention: '6h', review: '1d', bell })
    expect(toggleNotifyFrequency(undefined, 'deadline', '6h')).toEqual({ deadline: '6h' })
    expect(toggleNotifyFrequency({ deadline: 'none' }, 'deadline', 'immediate')).toEqual({ deadline: 'immediate' })
  })
})
