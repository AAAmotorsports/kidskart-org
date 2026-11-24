// =============================================================================
// メールアドレス正規化・バリデーション
//
// 目的: 「全角 @」「全角ピリオド」「全角英数字」「前後の空白」で入力された
//       メールアドレスを Resend が受け付ける形に整える。
//
// Resend は 422 Invalid `to` field で非 ASCII を弾く。これまで予約フォーム
// で全角混じりのアドレスが入ってもサーバーで素通りしていたため、サンキュー
// メール cron が毎日同じ予約でリトライ失敗する事故があった (2026-11-22)。
// =============================================================================

/**
 * 全角→半角 (NFKC) + trim。失敗しても例外は投げず、元の文字列を返す。
 */
export function normalizeEmail(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw;
  try {
    s = s.normalize('NFKC');
  } catch {
    // 古い環境で normalize が使えなくても落ちないように
  }
  // 前後 (半角/全角) 空白を除去
  s = s.trim();
  return s;
}

/**
 * ASCII のみ + 最低限のメール形式を満たすか。
 * - 制御文字 / 非 ASCII 文字が 1 つでもあれば false
 * - RFC 5321 の厳密 regex ではなく、実運用で通したい最低形を採用:
 *   local-part@domain.tld
 */
export function isValidAsciiEmail(email: string): boolean {
  if (!email) return false;
  // 非 ASCII (0x00-0x1F, 0x7F, >= 0x80) が残っていたら不可
  if (/[^\x20-\x7E]/.test(email)) return false;
  // local@domain.tld の最低形
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email);
}

/**
 * 入力メールを正規化しつつ検証し、エラー時は message を返す。
 * 成功時: { ok: true, email: '<normalized>' }
 * 失敗時: { ok: false, email: '<normalized or raw>', message: '...' }
 */
export function normalizeAndValidateEmail(raw: string):
  | { ok: true; email: string }
  | { ok: false; email: string; message: string }
{
  const originalTrimmed = (raw ?? '').trim();
  const normalized = normalizeEmail(raw);
  if (!normalized) {
    return { ok: false, email: normalized, message: 'メールアドレスを入力してください' };
  }
  if (!isValidAsciiEmail(normalized)) {
    const changed = originalTrimmed && originalTrimmed !== normalized;
    const hint = changed
      ? '全角文字を半角に変換しましたが、形式が不正です。半角英数字 + @ + . で入力してください (例: taro@example.com)'
      : 'メールアドレスは半角英数字 + @ + . で入力してください (全角文字・空白は使えません)';
    return { ok: false, email: normalized, message: hint };
  }
  return { ok: true, email: normalized };
}
