// PII マスキング共通ヘルパ (security-review C2 + H1 で導入)。
//
// 使い分け:
//   - 公開 UI (reserve/complete 等) で保護者本人がざっと確認するための軽い
//     マスク (先頭 1 文字 + 末尾残し等)
//   - ログ (Cloudflare Logs) に出すときは より強め (ドメインのみ、または hash)
//
// 「どこまで出して、どこから隠すか」の判断軸:
//   - 本人が自分の入力を見返すために判別できる最低限は残す
//   - URL を転送された第三者 or ログ閲覧者には身元特定できないようにする

/** 氏名の先頭 1 文字 + "***" (日本語・英語共通) */
export function maskName(name: string | null | undefined): string {
  if (!name) return '—';
  const t = name.trim();
  if (t.length === 0) return '—';
  if (t.length === 1) return t + '***';
  return t.charAt(0) + '***';
}

/** ユーザー名部分の先頭 1 文字 + "***@" + ドメイン */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = user.charAt(0) || '*';
  return `${head}***@${domain}`;
}

/** 電話番号の先頭 3 桁 + "-****-" + 末尾 4 桁 (数字だけ抽出) */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/**
 * ログ出力専用: email を "<domain>" にだけ縮退 (= ユーザー名部分を一切出さない)。
 * Cloudflare Logs は保持期間が長いので、個人特定可能な email を出さない。
 * 送信先追跡の目的ならドメイン名で十分 (gmail.com / icloud.com 等の内訳が分かる)。
 */
export function maskEmailForLog(email: string | null | undefined): string {
  if (!email) return '(none)';
  const at = email.indexOf('@');
  if (at <= 0) return '(invalid)';
  return `***@${email.slice(at + 1)}`;
}

/**
 * ログ出力専用: phone を "<先頭3桁>-***" にだけ縮退 (末尾を出さない)。
 * 先頭 3 桁は国/キャリア判別には使えるが個人特定にはならない。
 */
export function maskPhoneForLog(phone: string | null | undefined): string {
  if (!phone) return '(none)';
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length < 3) return '(invalid)';
  return `${digits.slice(0, 3)}-***`;
}
