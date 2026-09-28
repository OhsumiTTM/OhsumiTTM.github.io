// 紹介ページ・プライバシーポリシー・利用規約(content/legal/*.md)を表示するための、
// 小さな Markdown の変換。ビルド時にサーバー側で実行し、静的な HTML になる。
// 対応している書き方: 見出し(#)、段落、行末の空白2つでの改行、表(| … |)、
// 箇条書き(- )、番号付きの箇条書き(1. )、太字(**)、リンク([text](url))
import type { ReactNode } from 'react'

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }

const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }
    if (line.trim().startsWith('|') && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]))
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const listType = /^\s*-\s+/.test(line) ? 'ul' : /^\s*\d+\.\s+/.test(line) ? 'ol' : null
    if (listType) {
      const marker = listType === 'ul' ? /^\s*-\s+/ : /^\s*\d+\.\s+/
      const items: string[] = []
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ''))
      blocks.push({ type: listType, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*(-|\d+\.)\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|')
    ) {
      para.push(lines[i++])
    }
    blocks.push({ type: 'paragraph', lines: para })
  }
  return blocks
}

// 太字とリンク。外部のリンクは新しいタブで開く
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyPrefix}-${n++}`
    if (m[1] !== undefined) {
      out.push(<strong key={key} className="font-semibold text-foreground">{renderInline(m[1], key)}</strong>)
    } else {
      const href = m[3]
      const external = /^https?:\/\//.test(href)
      out.push(
        <a
          key={key}
          href={href}
          className="text-primary underline underline-offset-2"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {renderInline(m[2], key)}
        </a>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-2xl font-semibold tracking-tight',
  2: 'mt-10 text-lg font-semibold tracking-tight',
  3: 'mt-6 text-base font-semibold',
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="text-sm leading-7 text-foreground/90">
      {parseMarkdown(source).map((block, bi) => {
        const key = `b${bi}`
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(block.level, 6)}` as 'h1'
            return (
              <Tag key={key} className={HEADING_CLASS[block.level] ?? 'mt-4 font-semibold'}>
                {renderInline(block.text, key)}
              </Tag>
            )
          }
          case 'paragraph':
            return (
              <p key={key} className="mt-4">
                {block.lines.map((line, li) => (
                  <span key={li}>
                    {renderInline(line.replace(/\s{2,}$/, ''), `${key}-${li}`)}
                    {/\s{2,}$/.test(line) && li < block.lines.length - 1 ? <br /> : li < block.lines.length - 1 ? ' ' : null}
                  </span>
                ))}
              </p>
            )
          case 'ul':
          case 'ol': {
            const Tag = block.type
            return (
              <Tag key={key} className={`mt-4 space-y-1.5 pl-6 ${block.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
                {block.items.map((item, ii) => (
                  <li key={ii}>{renderInline(item, `${key}-${ii}`)}</li>
                ))}
              </Tag>
            )
          }
          case 'table':
            // 幅の狭い画面では、表だけを横にスクロールできるようにする(ページ全体は崩さない)
            return (
              <div key={key} className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[520px] border-collapse text-left text-[13px] leading-6">
                  <thead className="bg-secondary/60">
                    <tr>
                      {block.header.map((cell, ci) => (
                        <th key={ci} scope="col" className="border-b border-border px-3 py-2 font-semibold">
                          {renderInline(cell, `${key}-h${ci}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-border last:border-b-0">
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-3 py-2 align-top">
                            {renderInline(cell, `${key}-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}
