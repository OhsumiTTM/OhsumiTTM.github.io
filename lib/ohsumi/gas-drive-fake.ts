// 偽の Drive(バックアップのフォルダとコピー)と、バックアップのスプレッドシートを開く SpreadsheetApp.openById。
// gas-guard-harness の上で使う(lib/ohsumi/gas-backup.test.ts・gas-privacy.test.ts)
import { FakeSheet, noop, type Cell, type guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>

// 偽の Drive: バックアップのフォルダと、コピーしたスプレッドシート
export function withDrive(h: H, opts: { failCopy?: boolean } = {}) {
  type File = { id: string; name: string; created: number; trashed: boolean; folder: string; sheets: Record<string, Cell[][]>; editorsRemoved: string[]; sharing: unknown[] }
  const files: File[] = []
  const copies: string[] = []
  let now = Date.parse('2026-10-01T06:00:00+09:00')
  const handle = (f: File) => noop({
    getId: () => f.id, getName: () => f.name, getDateCreated: () => new Date(f.created),
    setTrashed: (v: boolean) => { f.trashed = v },
    getEditors: () => ['editor@example.com'], getViewers: () => ['viewer@example.com'],
    removeEditor: (u: string) => { f.editorsRemoved.push(u) }, removeViewer: (u: string) => { f.editorsRemoved.push(u) },
    setSharing: (...a: unknown[]) => { f.sharing.push(a) },
  })
  const folder = noop({
    getId: () => 'backup-folder',
    getFiles: () => {
      const list = files.filter((f) => !f.trashed && f.folder === 'backup-folder')
      let i = 0
      return { hasNext: () => i < list.length, next: () => handle(list[i++]) }
    },
    getEditors: () => [], getViewers: () => [], setSharing: () => {},
  })
  h.c.DriveApp = noop({
    Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
    createFolder: () => folder,
    getFolderById: (id: string) => { if (id !== 'backup-folder') throw new Error('no folder'); return folder },
    getFileById: (id: string) => {
      if (id === 'ss') {
        return noop({
          makeCopy: (name: string, dest: { getId: () => string }) => {
            if (opts.failCopy) throw new Error('Drive の容量が足りません')
            copies.push(id)
            const f: File = { id: 'bk' + (files.length + 1), name, created: now, trashed: false, folder: dest.getId(), editorsRemoved: [], sharing: [],
              sheets: Object.fromEntries(Object.entries(h.sheets).map(([n, s]) => [n, s.rows.map((r) => r.slice())])) }
            files.push(f)
            return handle(f)
          },
        })
      }
      const f = files.find((x) => x.id === id)
      if (!f) throw new Error('no file')
      return handle(f)
    },
  })
  // バックアップのスプレッドシートを開く
  const real = h.c.SpreadsheetApp as { getActiveSpreadsheet: () => unknown; flush: () => void }
  h.c.SpreadsheetApp = noop({
    flush: () => {},
    getActiveSpreadsheet: () => real.getActiveSpreadsheet(),
    openById: (id: string) => {
      const f = files.find((x) => x.id === id && !x.trashed)
      if (!f) throw new Error('no file')
      const sheets = Object.entries(f.sheets).map(([n, rows]) => new FakeSheet(n, rows.map((r) => r.slice())))
      return noop({ getSheets: () => sheets.map((s) => noop(s)), getSheetByName: (n: string) => { const s = sheets.find((x) => x.name === n); return s ? noop(s) : null } })
    },
  })
  h.props.BACKUP_FOLDER_ID = 'backup-folder'
  return { files, copies, setNow: (ms: number) => { now = ms }, live: () => files.filter((f) => !f.trashed) }
}

