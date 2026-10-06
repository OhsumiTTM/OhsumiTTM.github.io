// コメントから作るベルの通知(メンション・返信・メンションした相手のコメント)と、日程調整・フォームの招待。
// 通知はデータから毎回作り直す(store.tsx の allNotifications)。既読は通知の履歴(notification-history.ts。
// GAS の本人だけの保存)に残るので、ほかの端末でも既読になる。
//   - mention: 自分がメンションされたコメント
//   - reply: 自分のコメントへの返信 / 自分がメンションされたコメントへの返信(返信した本人を除く)
//   - mentionFollow: 自分がメンションした相手が、その後そのタスクに初めて書いたコメント(返信を使わなかった返事を救う)
// 古いコメント(COMMENT_NOTIFY_DAYS より前)からは作らない(履歴は90日で消えるので、消えた後にまた未読で出さないため)
import type { NotificationItem, Task, TaskComment } from './types'

export const COMMENT_NOTIFY_DAYS = 60
const SNIPPET = 40

export interface CommentNotificationText {
  mention: (taskName: string) => string
  reply: (name: string, taskName: string) => string
  mentionFollow: (name: string, taskName: string) => string
  mentionFollowDetail: (snippet: string) => string
}

const snippet = (text: string) => (text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text)

function recent(c: TaskComment, now: Date): boolean {
  const t = Date.parse(c.at)
  return !Number.isFinite(t) || t >= now.getTime() - COMMENT_NOTIFY_DAYS * 86400000
}

export function commentNotifications(
  tasks: Task[],
  me: string,
  nameOf: (memberId: string) => string,
  text: CommentNotificationText,
  now: Date = new Date(),
): NotificationItem[] {
  const out: NotificationItem[] = []
  for (const task of tasks) {
    const comments = (task.comments ?? []).filter(Boolean)
    if (!comments.length) continue
    const byId = new Map(comments.map((c) => [c.id, c]))
    // 時刻の順(同じ時刻は並びの順)
    const ordered = comments
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.at < b.c.at ? -1 : a.c.at > b.c.at ? 1 : a.i - b.i))
      .map((x) => x.c)
    const notifiedReply = new Set<string>()
    for (const c of ordered) {
      if (c.byId === me || !recent(c, now)) continue
      if (c.mentionedIds?.includes(me)) {
        out.push({ id: `mention-${c.id}`, kind: 'mention', bell: 'mention', title: text.mention(task.name), detail: snippet(c.text), taskId: task.id, commentId: c.id })
        continue
      }
      const parent = c.replyToId ? byId.get(c.replyToId) : undefined
      if (parent && (parent.byId === me || parent.mentionedIds?.includes(me))) {
        notifiedReply.add(c.id)
        out.push({ id: `reply-${c.id}`, kind: 'reply', bell: 'mention', title: text.reply(nameOf(c.byId), task.name), detail: snippet(c.text), taskId: task.id, commentId: c.id })
      }
    }
    // 自分がメンションした相手の、その後の初めてのコメント(返信・自分へのメンションで通知したものは除く)
    const myMentions = ordered.filter((c) => c.byId === me && c.mentionedIds?.length)
    const seen = new Set<string>()
    for (const m of myMentions) {
      for (const target of m.mentionedIds ?? []) {
        if (target === me) continue
        const after = ordered.slice(ordered.indexOf(m) + 1)
        const first = after.find((c) => c.byId === target)
        if (!first || seen.has(first.id) || notifiedReply.has(first.id) || first.mentionedIds?.includes(me) || !recent(first, now)) continue
        seen.add(first.id)
        out.push({
          id: `mention-follow-${first.id}`, kind: 'reply', bell: 'mention',
          title: text.mentionFollow(nameOf(target), task.name), detail: text.mentionFollowDetail(snippet(first.text)),
          taskId: task.id, commentId: first.id,
        })
      }
    }
  }
  return out
}

/** 日程調整・フォームに招待されていて、まだ答えていないタスク(完了したものは除く) */
export function inviteNotifications(
  tasks: Task[],
  me: string,
  text: { schedule: (taskName: string) => string; form: (taskName: string) => string; detail: string },
): NotificationItem[] {
  const out: NotificationItem[] = []
  for (const task of tasks) {
    if (task.status === 'done') continue
    const s = task.schedule
    if (s?.invitedIds?.includes(me) && !Object.keys(s.responses?.[me] ?? {}).length) {
      out.push({ id: `invite-schedule-${task.id}`, kind: 'invite', bell: 'invite', title: text.schedule(task.name), detail: text.detail, taskId: task.id })
    }
    const f = task.form
    if (f?.invitedIds?.includes(me) && !Object.keys(f.responses?.[me] ?? {}).length) {
      out.push({ id: `invite-form-${task.id}`, kind: 'invite', bell: 'invite', title: text.form(task.name), detail: text.detail, taskId: task.id })
    }
  }
  return out
}

/**
 * 返信の並び: 元のコメントの下に、返信を時刻の順に並べる(1段だけ。返信への返信は、いちばん上のコメントの下に並べる)。
 * 元が無い返信は、ふつうのコメントとして扱う
 */
export function threadComments(comments: TaskComment[]): { comment: TaskComment; replies: TaskComment[] }[] {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const rootOf = (c: TaskComment): TaskComment => {
    let cur = c
    const visited = new Set<string>([c.id])
    while (cur.replyToId && byId.has(cur.replyToId) && !visited.has(cur.replyToId)) {
      cur = byId.get(cur.replyToId)!
      visited.add(cur.id)
    }
    return cur
  }
  const byRoot = new Map<string, TaskComment[]>()
  const roots: TaskComment[] = []
  for (const c of comments) {
    const root = rootOf(c)
    if (root.id === c.id) roots.push(c)
    else byRoot.set(root.id, [...(byRoot.get(root.id) ?? []), c])
  }
  return roots.map((c) => ({ comment: c, replies: (byRoot.get(c.id) ?? []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) }))
}
