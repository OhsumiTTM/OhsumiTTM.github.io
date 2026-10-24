'use client'

// ナレッジのページの本文(Markdown)を表示する。メンバーが書いた文なので、HTML は使わず、決まった書き方だけを部品にする:
//   見出し(#)・段落・行末の空白2つでの改行・箇条書き(- )・番号付き(1. )・引用(> )・区切り線(---)・表(| … |)・
//   コードのかたまり(```)・太字(**)・コード(`)・リンク([文字](URL)。http・https・mailto だけ)・画像(![説明](wiki:<ファイルID>))
// 画像は団体の GAS から権限を確かめて読む(lib/ohsumi/files.ts。読めない画像は説明の文字だけを出す)
import type { ReactNode } from 'react'
import { useFileUrl } from '@/lib/ohsumi/files'
import { parseWikiMarkdown, safeWikiHref, wikiImageUrl } from '@/lib/ohsumi/wiki'

function WikiImage({ fileId, alt }: { fileId: string; alt: string }) {
  const src = useFileUrl(wikiImageUrl(fileId))
  if (!src) return <span className="inline-block rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-wiki-image={fileId}>{alt || '画像'}</span>
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="my-2 max-h-[480px] max-w-full rounded-md border border-border" data-wiki-image={fileId} />
}

// 画像・リンク・太字・コード
export function renderWikiInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /!\[([^\]]*)\]\(wiki:([A-Za-z0-9_-]{10,200})\)|\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyPrefix}-${n++}`
    if (m[2] !== undefined) {
      out.push(<WikiImage key={key} fileId={m[2]} alt={m[1]} />)
    } else if (m[3] !== undefined) {
      out.push(<strong key={key} className="font-semibold text-foreground">{renderWikiInline(m[3], key)}</strong>)
    } else if (m[4] !== undefined) {
      out.push(<code key={key} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.9em]">{m[4]}</code>)
    } else {
      const href = safeWikiHref(m[6])
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="break-words text-primary underline underline-offset-2">
            {renderWikiInline(m[5], key)}
          </a>
        ) : (
          <span key={key}>{m[5]}</span>
        ),
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-6 text-xl font-semibold tracking-tight',
  2: 'mt-6 text-lg font-semibold tracking-tight',
  3: 'mt-5 text-base font-semibold',
}

export function WikiMarkdown({ source }: { source: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-7 text-foreground/90" data-wiki-body>
      {parseWikiMarkdown(source).map((block, bi) => {
        const key = `b${bi}`
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2'
            return <Tag key={key} className={HEADING_CLASS[block.level] ?? 'mt-4 font-semibold'}>{renderWikiInline(block.text, key)}</Tag>
          }
          case 'paragraph':
            return (
              <p key={key} className="mt-3">
                {block.lines.map((line, li) => (
                  <span key={li}>
                    {renderWikiInline(line.replace(/\s{2,}$/, ''), `${key}-${li}`)}
                    {li < block.lines.length - 1 ? (/\s{2,}$/.test(line) ? <br /> : ' ') : null}
                  </span>
                ))}
              </p>
            )
          case 'ul':
          case 'ol': {
            const Tag = block.type
            return (
              <Tag key={key} className={`mt-3 space-y-1 pl-6 ${block.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
                {block.items.map((item, ii) => <li key={ii}>{renderWikiInline(item, `${key}-${ii}`)}</li>)}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={key} className="mt-3 border-l-4 border-border pl-3 text-muted-foreground">
                {block.lines.map((line, li) => <p key={li}>{renderWikiInline(line, `${key}-${li}`)}</p>)}
              </blockquote>
            )
          case 'code':
            return <pre key={key} className="mt-3 overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs leading-5"><code>{block.text}</code></pre>
          case 'hr':
            return <hr key={key} className="my-5 border-border" />
          case 'table':
            return (
              <div key={key} className="mt-3 overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead>
                    <tr>{block.header.map((h, hi) => <th key={hi} className="border border-border bg-secondary px-2 py-1 text-left font-semibold">{renderWikiInline(h, `${key}-h${hi}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>{row.map((c, ci) => <td key={ci} className="border border-border px-2 py-1 align-top">{renderWikiInline(c, `${key}-${ri}-${ci}`)}</td>)}</tr>
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
