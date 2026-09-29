// 役職の表示名を返す関数(画面の言語と、今の役職の一覧に合わせる)
import { useCallback } from 'react'
import { useOhsumi } from './store'
import { roleLabel, useI18n } from './i18n'

export function useRoleLabel(): (ref: string | null | undefined) => string {
  const { roles } = useOhsumi()
  const { t } = useI18n()
  return useCallback((ref) => roleLabel(t, roles, ref), [t, roles])
}
