// 部門の表示名を返す関数(画面の言語と、今の部門の一覧に合わせる)
import { useCallback } from 'react'
import { useOhsumi } from './store'
import { departmentLabel, useI18n } from './i18n'

export function useDepartmentLabel(): (ref: string | null | undefined) => string {
  const { departments } = useOhsumi()
  const { t } = useI18n()
  return useCallback((ref) => departmentLabel(t, departments, ref), [t, departments])
}
