'use client'

// 団体の GAS が、サイトの URL(レジストリの SITE_ORIGINS)を知っているか。知らない団体(レジストリに一度も
// 確かめられていない)では、招待リンクをメールで送れない(新しいメンバーへの招待メール・自分のメールに送る)
import { useEffect, useState } from 'react'
import { isRemoteConfigured, remoteApi } from './remote'

export function useSiteLinkStatus(enabled = true): { available: boolean; checking: boolean } {
  const [state, setState] = useState({ available: false, checking: enabled && isRemoteConfigured })
  useEffect(() => {
    if (!enabled || !isRemoteConfigured) return
    let alive = true
    remoteApi.getInviteMailStatus().then(
      // 自分あての上限・自分のアドレスの有無は関係ない。サイトの URL を知っているか(notChecked でないか)だけを見る
      (s) => { if (alive) setState({ available: s.reason !== 'notChecked', checking: false }) },
      () => { if (alive) setState({ available: false, checking: false }) },
    )
    return () => { alive = false }
  }, [enabled])
  return state
}
