// プロジェクトの健康状態の自動判定のうち、GAS に送るもの(記録の更新や通知が
// 必要なもの)を選ぶ。通知するかどうかの最終的な判断は GAS 側
// (reportProjectHealth)がシート上の記録と比べて行う。
//   - 手動上書き中のプロジェクトは送らない
//   - 記録が無い(一度も記録されていない)プロジェクトは、記録のために送る
//     (初回の計算なので、GAS 側は通知しない)
//   - attention 以外 → attention、attention → attention 以外 の場合に送る
import type { Project, ProjectHealthLevel } from './types'

export type ProjectHealthReport = { projectId: string; health: ProjectHealthLevel }

export function selectProjectHealthReports(
  projects: Project[],
  healthOf: (project: Project) => ProjectHealthLevel,
): ProjectHealthReport[] {
  const reports: ProjectHealthReport[] = []
  projects.forEach((p) => {
    if (p.healthOverride) return
    const health = healthOf(p)
    const last = p.lastNotifiedHealth
    const changed =
      !last ||
      (health === 'attention' && last !== 'attention') ||
      (health !== 'attention' && last === 'attention')
    if (changed) reports.push({ projectId: p.id, health })
  })
  return reports
}
