'use client'

// できる操作(lib/ohsumi/capabilities.ts)から決まる、画面の入口の出し分け
import { useOhsumi } from './store'

// 団体設定の画面を開けるか(右上のメニューと ADMIN の「団体設定」のタブ)。
// 団体のルール(org.rules)・ロゴ(org.logo)を変えられる人と、代表だけの項目(バックアップなど)を持つ代表
export function useCanOpenOrgSettings(): boolean {
  const { can, isTopRef, currentUser } = useOhsumi()
  return isTopRef(currentUser?.role) || can('org.rules') || can('org.logo')
}
