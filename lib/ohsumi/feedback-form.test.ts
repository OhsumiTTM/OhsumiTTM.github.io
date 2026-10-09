import { describe, expect, it } from 'vitest'
import {
  buildFeedbackBody, checkScreenshotFile, FEEDBACK_ENTRY, screenshotObjectName, screenshotPublicUrl, uploadScreenshot,
  type FeedbackValues,
} from './feedback-form'

const base: FeedbackValues = {
  orgName: 'つばさ学生会議', yourName: '', contactType: '不具合の報告', otherDetail: '', features: [],
  detail: '動かない', steps: '', severity: '今困っていて業務が止まっている', wantReply: '返信してほしい', email: 'a@example.com',
  screenshotUrls: [],
}

describe('Google フォームに送る内容', () => {
  it('選択肢は、Google フォームの選択肢の文字そのもので送る', () => {
    const b = buildFeedbackBody(base)
    expect(b.get(FEEDBACK_ENTRY.contactType)).toBe('不具合の報告（正しく動かない）')
    expect(b.get(FEEDBACK_ENTRY.severity)).toBe('今困っていて、業務が止まっている')
    expect(b.get(FEEDBACK_ENTRY.wantReply)).toBe('返信してほしい（Q2のお名前と、以下に連絡先を記入してください）')
    expect(buildFeedbackBody({ ...base, contactType: '機能の改善要望' }).get(FEEDBACK_ENTRY.contactType)).toBe('機能の改善要望（今ある機能を使いやすくしたい）')
    expect(buildFeedbackBody({ ...base, wantReply: '返信は不要' }).get(FEEDBACK_ENTRY.wantReply)).toBe('返信は不要')
  })

  it('「その他」は、フォームの「その他」として自由記入と一緒に送る', () => {
    const b = buildFeedbackBody({ ...base, contactType: 'その他', otherDetail: '契約のこと' })
    expect(b.get(FEEDBACK_ENTRY.contactType)).toBe('__other_option__')
    expect(b.get(FEEDBACK_ENTRY.contactType + '.other_option_response')).toBe('契約のこと')
  })

  it('対象の機能・画面(記述式)は1つの文に、スクリーンショットはリンクを改行でつなげて送る', () => {
    const b = buildFeedbackBody({ ...base, features: ['個人ページ', 'その他'], screenshotUrls: ['https://x/1.png', 'https://x/2.png'] })
    expect(b.getAll(FEEDBACK_ENTRY.features)).toEqual(['個人ページ、その他'])
    expect(b.get(FEEDBACK_ENTRY.screenshots)).toBe('https://x/1.png\nhttps://x/2.png')
  })

  it('不具合の報告でなければ、困り具合を送らない。空の欄は送らない', () => {
    const b = buildFeedbackBody({ ...base, contactType: '新機能の提案', severity: '' })
    expect(b.has(FEEDBACK_ENTRY.severity)).toBe(false)
    expect(b.has(FEEDBACK_ENTRY.yourName)).toBe(false)
    expect(b.has(FEEDBACK_ENTRY.screenshots)).toBe(false)
  })
})

describe('スクリーンショット', () => {
  it('PNG・JPG・WebP の 5MB までだけ受け付ける', () => {
    expect(checkScreenshotFile({ name: 'a.png', size: 10 })).toBeNull()
    expect(checkScreenshotFile({ name: 'a.JPG', size: 10 })).toBeNull()
    expect(checkScreenshotFile({ name: 'a.gif', size: 10 })).toMatch(/PNG・JPG・WebP/)
    expect(checkScreenshotFile({ name: 'a.png', size: 5 * 1024 * 1024 + 1 })).toMatch(/5MB/)
    expect(checkScreenshotFile({ name: 'a.png', size: 0 })).toMatch(/空/)
  })

  it('名前に元のファイル名を使わない。Ohsumi バケットの feedback/ の公開 URL を返す', () => {
    expect(screenshotObjectName('png', 1, 'abcd1234-ef56-7890-abcd-ef1234567890')).toBe('feedback-1-abcd1234ef567890.png')
    expect(screenshotPublicUrl('https://p.supabase.co', 'n.png')).toBe('https://p.supabase.co/storage/v1/object/public/Ohsumi/feedback/n.png')
  })

  it('anon key で Ohsumi バケットの feedback/ に上げ(上書きしない)、公開 URL を返す。失敗は日本語の文で返す', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchOk = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    const file = new File([new Uint8Array([1, 2, 3])], '私の画面.png', { type: 'image/png' })
    const res = await uploadScreenshot(file, { config: { url: 'https://p.supabase.co', anonKey: 'anon' }, fetch: fetchOk, now: 5, uuid: '00000000-0000-0000-0000-000000000000' })
    expect(res).toEqual({ ok: true, url: 'https://p.supabase.co/storage/v1/object/public/Ohsumi/feedback/feedback-5-0000000000000000.png' })
    expect(calls[0].url).toBe('https://p.supabase.co/storage/v1/object/Ohsumi/feedback/feedback-5-0000000000000000.png')
    const h = calls[0].init.headers as Record<string, string>
    expect(h.apikey).toBe('anon')
    expect(h['x-upsert']).toBe('false')
    expect(h['Content-Type']).toBe('image/png')
    const fetchNg = (async () => new Response('', { status: 403 })) as unknown as typeof fetch
    expect(await uploadScreenshot(file, { config: { url: 'https://p.supabase.co', anonKey: 'anon' }, fetch: fetchNg })).toMatchObject({ ok: false, error: expect.stringMatching(/403/) })
    expect(await uploadScreenshot(file, { config: { url: '', anonKey: '' } })).toMatchObject({ ok: false })
  })
})
