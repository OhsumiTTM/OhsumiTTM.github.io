// 管理画面のタブ・グループの名前と説明の翻訳キー(lib/ohsumi/i18n の admin.section.* / admin.group.*)
import type { AdminGroupKey } from './admin-sections'
import type { TranslationKey } from './i18n'
import type { AdminSection } from './types'

export function adminSectionTitleKey(section: AdminSection): TranslationKey {
  return `admin.section.${section}.title` as TranslationKey
}

export function adminSectionDescKey(section: AdminSection): TranslationKey {
  return `admin.section.${section}.desc` as TranslationKey
}

export function adminGroupTitleKey(group: AdminGroupKey): TranslationKey {
  return `admin.group.${group}` as TranslationKey
}
