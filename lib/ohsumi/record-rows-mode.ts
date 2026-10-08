// データの持ち方の欄(components/ohsumi/record-rows-panel.tsx)に出す操作を決める(純粋な関数)。
//   none      移す(試す → 移す)
//   migrating 続きから移す(試すも出す)
//   failed    戻す(照合が合わなかった。記録のシートを空にして、セルのままに戻す)
//   reverting 戻す(戻している途中。最後まで進める)
//   done      移してから30日以内だけ戻す。それより後と、最初から行に持つ新しい団体(setupOhsumi。移行の
//             バックアップが無い)は、状態の1行だけを出す
import type { RecordRowsStatus } from './remote'

export const RECORD_ROWS_REVERT_DAYS = 30

export type RecordRowsMode = 'migrate' | 'resume' | 'revert' | 'statusOnly'

export function recordRowsMode(status: Pick<RecordRowsStatus, 'state' | 'since' | 'backup'>, nowMs: number = Date.now()): RecordRowsMode {
  if (status.state === 'none') return 'migrate'
  if (status.state === 'migrating') return 'resume'
  if (status.state === 'failed' || status.state === 'reverting') return 'revert'
  const since = Date.parse(status.since || '')
  const migrated = !!status.backup && Number.isFinite(since)
  return migrated && nowMs - since <= RECORD_ROWS_REVERT_DAYS * 86400000 ? 'revert' : 'statusOnly'
}
