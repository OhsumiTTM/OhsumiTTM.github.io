'use client'

import { useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ApplySection, ApplyValues } from '@/lib/site/apply-form'
import { OTHER_CHOICE } from '@/lib/site/apply-form'

// サイトの見た目のフォームから、裏で Google フォームの受付先(formResponse)に送る。
// 埋め込み(iframe)は使わない(ページの安全の設定 CSP を緩めないため。送り先は CSP の connect-src で許している)。
// Google の仕組み上、届いたかは画面で確かめられない(no-cors)。送る前に画面で入力を確かめる
const WAIT_MS = 60 * 1000 // 続けて送れないようにする(迷惑な送信を防ぐ)

// ファイルの項目(type: 'file')の受け付け方。ファイルは選んだ時には上げず、送信を押した時に上げて、
// その URL を値に入れてから Google フォームへ送る(送信をやめた人のファイルを残さないため)
export interface FileUploadOptions {
  // 受け付けるか(送り先の設定が無いビルドでは false。その時は欄に disabledNote を出し、必須にしない)
  enabled: boolean
  accept: string
  // 選んだ時の確かめ(問題があれば文)
  check: (file: File) => string | null
  upload: (file: File) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
  uploadingLabel: string
  disabledNote: string
}

export function GoogleBackedForm({
  sections,
  action,
  validate,
  build,
  storageKey,
  successTitle,
  successBody,
  submitLabel = '送信する',
  fileUpload,
}: {
  sections: ApplySection[]
  action: string
  validate: (v: ApplyValues) => Record<string, string>
  build: (v: ApplyValues) => URLSearchParams
  storageKey: string
  successTitle: string
  successBody: string
  submitLabel?: string
  fileUpload?: FileUploadOptions
}) {
  const [values, setValues] = useState<ApplyValues>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [state, setState] = useState<'idle' | 'uploading' | 'sending' | 'done' | 'error'>('idle')
  // 選んだファイル(項目ごと)と、選んだ時の確かめの結果
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  // 上げ終わったファイルの URL(Google フォームへの送信に失敗して送り直す時に、同じファイルを2回上げない)
  const uploaded = useRef(new Map<File, string>())
  const fileFields = sections.flatMap((s) => s.fields).filter((f) => f.type === 'file')
  const filesOn = !!fileUpload?.enabled
  const [message, setMessage] = useState('')
  // 迷惑な自動送信よけ(人には見えない欄。入っていたら送らない)
  const [trap, setTrap] = useState('')

  const set = (key: string, v: string | string[]) => setValues((prev) => ({ ...prev, [key]: v }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    // ファイルはまだ上げていないので、選んであれば入っているものとして確かめる
    const forCheck: ApplyValues = { ...values }
    for (const f of fileFields) forCheck[f.key] = filesOn && files[f.key] ? 'selected' : ''
    const errs = validate(forCheck)
    if (filesOn) for (const f of fileFields) if (fileErrors[f.key]) errs[f.key] = fileErrors[f.key]
    setErrors(errs)
    if (Object.keys(errs).length) {
      setMessage('入力に問題のある項目があります。赤い字の項目をご確認ください。')
      const first = document.querySelector('[data-field-error]')
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (trap) { setState('done'); return }
    try {
      const last = Number(sessionStorage.getItem(storageKey) || 0)
      if (last && Date.now() - last < WAIT_MS) {
        setMessage('少し前に送信したばかりです。1分ほど待ってから、もう一度お試しください。')
        return
      }
    } catch { /* 保存できない時は確かめない */ }
    // ファイルを上げてから、その URL を値に入れて送る。上げられなければ送らない
    let toSend: ApplyValues = values
    if (filesOn && fileUpload) {
      for (const f of fileFields) {
        const file = files[f.key]
        if (!file) continue
        let url = uploaded.current.get(file)
        if (!url) {
          setState('uploading')
          setMessage(fileUpload.uploadingLabel)
          const r = await fileUpload.upload(file)
          if (!r.ok) {
            setState('error')
            setErrors({ [f.key]: r.error })
            setMessage(r.error)
            return
          }
          url = r.url
          uploaded.current.set(file, url)
        }
        toSend = { ...toSend, [f.key]: url }
      }
    }
    setState('sending')
    setMessage('')
    try {
      await fetch(action, { method: 'POST', mode: 'no-cors', body: build(toSend) })
      try { sessionStorage.setItem(storageKey, String(Date.now())) } catch { /* ignore */ }
      setState('done')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      setState('error')
      setMessage('送信できませんでした。通信の状態を確かめて、もう一度お試しください。')
    }
  }

  if (state === 'done') {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 md:p-8" role="status">
        <CheckCircle2 className="size-8 text-primary" aria-hidden />
        <h2 className="mt-3 text-lg font-semibold">{successTitle}</h2>
        <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{successBody}</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-8">
      {sections.map((section) => (
        <fieldset key={section.title} className="rounded-2xl border border-border bg-card p-5 md:p-7">
          <legend className="px-1 text-base font-semibold text-foreground">{section.title}</legend>
          {section.description && <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>}
          <div className="mt-5 space-y-6">
            {section.fields.map((f) => {
              const err = errors[f.key]
              const id = 'f-' + f.key
              const label = (
                <span className="text-sm font-medium text-foreground">
                  {f.label}
                  {f.required && (f.type !== 'file' || filesOn) && <span className="ml-1 text-xs text-destructive">必須</span>}
                </span>
              )
              const help = f.help && <span className="mt-0.5 block text-xs text-muted-foreground">{f.help}</span>
              const inputClass = cn(
                'mt-2 w-full rounded-lg border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary',
                err ? 'border-destructive' : 'border-border',
              )
              return (
                <div key={f.key} {...(err ? { 'data-field-error': '' } : {})}>
                  {f.type === 'radio' || f.type === 'checks' ? (
                    <div role="group" aria-labelledby={id + '-label'}>
                      <div id={id + '-label'}>{label}{help}</div>
                      <div className="mt-2 grid gap-2">
                        {(f.options ?? []).map((o) => {
                          const checked = f.type === 'radio'
                            ? values[f.key] === o
                            : Array.isArray(values[f.key]) && (values[f.key] as string[]).includes(o)
                          return (
                            <label key={o} className="flex cursor-pointer items-start gap-2 text-sm">
                              <input
                                type={f.type === 'radio' ? 'radio' : 'checkbox'}
                                name={id}
                                className="mt-1 accent-primary"
                                checked={checked}
                                onChange={(e) => {
                                  if (f.type === 'radio') set(f.key, o)
                                  else {
                                    const cur = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : []
                                    set(f.key, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))
                                  }
                                }}
                              />
                              <span>{o}</span>
                            </label>
                          )
                        })}
                        {f.type === 'radio' && f.other && (
                          <label className="flex cursor-pointer items-start gap-2 text-sm">
                            <input type="radio" name={id} className="mt-1 accent-primary" checked={values[f.key] === OTHER_CHOICE} onChange={() => set(f.key, OTHER_CHOICE)} />
                            <span className="flex-1">
                              その他
                              {values[f.key] === OTHER_CHOICE && (
                                <input
                                  className={inputClass}
                                  value={String(values[f.key + '.other'] ?? '')}
                                  onChange={(e) => set(f.key + '.other', e.target.value)}
                                  aria-label={f.label + '(その他)'}
                                />
                              )}
                            </span>
                          </label>
                        )}
                      </div>
                    </div>
                  ) : f.type === 'file' ? (
                    <div>
                      <label htmlFor={id} className="block">{label}{help}</label>
                      {filesOn && fileUpload ? (
                        <input
                          id={id}
                          type="file"
                          accept={fileUpload.accept}
                          className={cn(inputClass, 'file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium')}
                          disabled={state === 'uploading' || state === 'sending'}
                          onChange={(e) => {
                            const file = e.target.files?.[0] ?? null
                            setFiles((prev) => ({ ...prev, [f.key]: file }))
                            setFileErrors((prev) => ({ ...prev, [f.key]: file ? fileUpload.check(file) ?? '' : '' }))
                            setErrors((prev) => { const next = { ...prev }; delete next[f.key]; return next })
                          }}
                        />
                      ) : (
                        <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground" data-file-disabled="">
                          {fileUpload?.disabledNote ?? 'いまファイルを受け付けられません。'}
                        </p>
                      )}
                      {!err && fileErrors[f.key] && <p className="mt-1 text-xs text-destructive">{fileErrors[f.key]}</p>}
                    </div>
                  ) : (
                    <label htmlFor={id} className="block">
                      {label}
                      {help}
                      {f.type === 'textarea' ? (
                        <textarea id={id} rows={4} className={inputClass} placeholder={f.placeholder}
                          value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
                      ) : (
                        <input id={id} type={f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'} className={inputClass}
                          placeholder={f.placeholder} autoComplete={f.type === 'email' ? 'email' : undefined}
                          value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
                      )}
                    </label>
                  )}
                  {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}

      <div aria-hidden className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label>
          この欄は空のままにしてください
          <input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </label>
      </div>

      {message && <p className={cn('text-sm', state === 'error' || Object.keys(errors).length ? 'text-destructive' : 'text-muted-foreground')} role="alert">{message}</p>}
      <button
        type="submit"
        disabled={state === 'sending' || state === 'uploading'}
        className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-primary px-6 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
      >
        {(state === 'sending' || state === 'uploading') && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {state === 'uploading' && fileUpload ? fileUpload.uploadingLabel : submitLabel}
      </button>
    </form>
  )
}
