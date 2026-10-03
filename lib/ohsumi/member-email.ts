// メンバーのメールアドレスの確かめ。Ohsumi はメールアドレスで本人を照合してログインさせるので、
// メンバーには必ずメールアドレスが要る。Google アカウントかどうかは確かめられないので、
// Gmail 以外のアドレスには「Google でログインできるか確かめて」と注意を出す(保存は止めない)

export function isValidEmail(value: string | undefined | null): boolean {
  const v = (value ?? '').trim()
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v)
}

const GOOGLE_DOMAINS = ['gmail.com', 'googlemail.com']

/** Gmail 以外のアドレス(会社・大学など)。Google アカウントでないとログインできない */
export function needsGoogleAccountCheck(value: string | undefined | null): boolean {
  if (!isValidEmail(value)) return false
  const domain = String(value).trim().split('@')[1].toLowerCase()
  return !GOOGLE_DOMAINS.includes(domain)
}
