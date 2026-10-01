// content/legal/*.md(紹介ページ・プライバシーポリシー・利用規約)が、見出し・表・
// 箇条書き・太字・リンクとして表示されることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, parseMarkdown } from './simple-markdown'

const legal = (name: string) => readFileSync(join(__dirname, '..', '..', 'content', 'legal', `${name}.md`), 'utf8')
const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />)

describe('simple-markdown', () => {
  it('見出し・段落・改行・箇条書き・番号付き・太字・リンク・表を変換する', () => {
    const out = html(
      [
        '# タイトル',
        '',
        '本文1行目  ',
        '2行目',
        '',
        '## 小見出し',
        '',
        '- 項目A',
        '- [リンク](/privacy/)',
        '',
        '1. **太字**:説明',
        '2. 二つ目',
        '',
        '| 列1 | 列2 |',
        '| --- | --- |',
        '| a | **b** |',
        '',
        '[外部](https://example.com)',
      ].join('\n'),
    )
    expect(out).toContain('<h1 class="text-2xl font-semibold tracking-tight">タイトル</h1>')
    expect(out).toMatch(/本文1行目<br\/><\/span><span>2行目<\/span>/)
    expect(out).toContain('>小見出し</h2>')
    expect(out).toMatch(/<ul[^>]*list-disc[^>]*><li>項目A<\/li><li><a href="\/privacy\/"[^>]*>リンク<\/a><\/li><\/ul>/)
    expect(out).toMatch(/<ol[^>]*list-decimal[^>]*><li><strong[^>]*>太字<\/strong>:説明<\/li><li>二つ目<\/li><\/ol>/)
    expect(out).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/)
    expect(out).toMatch(/<th scope="col"[^>]*>列1<\/th>/)
    expect(out).toMatch(/<td[^>]*><strong[^>]*>b<\/strong><\/td>/)
    expect(out).toMatch(/<a href="https:\/\/example.com"[^>]*target="_blank" rel="noopener noreferrer"/)
  })

  it('3つのページの内容を変換でき、未確定の箇所が残っていない', () => {
    const privacy = html(legal('privacy'))
    expect(privacy).toContain('>Ohsumi プライバシーポリシー</h1>')
    expect(privacy).toContain('制定日:2026年9月28日')
    expect(privacy).toContain('メールアドレス:<a href="mailto:fsif.official@gmail.com"')
    expect(privacy).toMatch(/<th scope="col"[^>]*>権限<\/th>/)
    expect(privacy).toMatch(/<strong[^>]*>利用組織の情報<\/strong>/)
    expect(parseMarkdown(legal('privacy')).filter((b) => b.type === 'table')).toHaveLength(1)

    const terms = html(legal('terms'))
    expect(terms).toContain('>第1条(定義)</h2>')
    expect(terms).toContain('制定日:2026年9月28日')
    expect(terms).toContain('、横浜地方裁判所を第一審')
    expect(terms).toContain('<a href="mailto:fsif.official@gmail.com"')

    const about = html(legal('about'))
    expect(about).toMatch(/<a href="\/privacy\/"[^>]*>プライバシーポリシー<\/a>/)
    expect(about).toMatch(/お問い合わせ:<a href="mailto:fsif.official@gmail.com"[^>]*>fsif.official@gmail.com<\/a>/)
    // Markdown の記号が本文に残っていない
    for (const out of [privacy, terms, about]) {
      expect(out).not.toMatch(/\*\*|\]\(|^#|\| ---/m)
      // 未確定の箇所([…] や XX)が残っていない
      // (クラス名の min-w-[520px] などを除くため、タグを取り除いた本文で確かめる)
      expect(out.replace(/<[^>]*>/g, '')).not.toMatch(/\[[^\]]*\]|XX/)
    }
  })
  it('箇条書きの中で字下げした表・区切りの無い「|」の行でも止まらない', () => {
    const blocks = parseMarkdown(['1. 料金は次のとおりです。', '', '   | 人数 | 料金 |', '   | --- | --- |', '   | 10人以下 | 10,000円 |', '', '| 区切りの無い行 |', '2. 次'].join('\n'))
    expect(blocks.map((b) => b.type)).toEqual(['ol', 'table', 'paragraph', 'ol'])
    expect(blocks[1]).toMatchObject({ header: ['人数', '料金'], rows: [['10人以下', '10,000円']] })
  })
})
