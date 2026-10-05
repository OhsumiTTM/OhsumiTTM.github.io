'use client'

// タスクのゴミ箱(代表・全権管理者だけ)。削除したタスクは30日間ここに残り、元に戻す・すぐに完全に消すことができる
// (GAS の removeTask・restoreTask・purgeTask。30日たったものは GAS の毎日の処理が消す)
import { useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { Modal } from '@/components/ohsumi/modal'
import { Button } from '@/components/ui/button'
import type { Task } from '@/lib/ohsumi/types'

const TRASH_DAYS = 30

function daysLeft(deletedAt: string | undefined, now: number): number {
  const at = deletedAt ? Date.parse(deletedAt) : NaN
  if (!Number.isFinite(at)) return TRASH_DAYS
  return Math.max(0, TRASH_DAYS - Math.floor((now - at) / 86400000))
}

export function TaskTrash() {
  const { trashedTasks, restoreTask, purgeTask, getProject, getMember, isFullAdmin } = useOhsumi()
  const { t } = useI18n()
  const toast = useToast()
  const [purging, setPurging] = useState<Task | null>(null)
  if (!isFullAdmin) return null
  const now = Date.now()
  const sorted = [...trashedTasks].sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')))

  return (
    <div className="mt-10">
      <h2 className="text-base font-semibold">{t('admin.trash.heading')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('admin.trash.desc', { days: TRASH_DAYS })}</p>
      <ul className="mt-4 flex flex-col gap-1.5">
        {sorted.map((task) => (
          <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{task.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[
                  getProject(task.projectId)?.name,
                  task.deletedById ? t('admin.trash.deletedBy', { name: getMember(task.deletedById)?.name ?? '' }) : '',
                  t('admin.trash.daysLeft', { days: daysLeft(task.deletedAt, now) }),
                ].filter(Boolean).join(' / ')}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  restoreTask(task.id)
                  toast(t('admin.trash.restored', { name: task.name }))
                }}
              >
                {t('admin.trash.restore')}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setPurging(task)}>
                {t('admin.trash.purge')}
              </Button>
            </div>
          </li>
        ))}
        {sorted.length === 0 && <li className="text-sm text-muted-foreground">{t('admin.trash.empty')}</li>}
      </ul>

      <Modal open={!!purging} onClose={() => setPurging(null)}>
        <h2 className="text-base font-semibold">{t('admin.trash.purgeModal.title', { name: purging?.name ?? '' })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('admin.trash.purgeModal.desc')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setPurging(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (purging) {
                purgeTask(purging.id)
                toast(t('admin.trash.purged', { name: purging.name }))
              }
              setPurging(null)
            }}
          >
            {t('admin.trash.purge')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
