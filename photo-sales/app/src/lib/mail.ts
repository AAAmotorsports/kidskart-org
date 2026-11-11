// Resend でメール送信。キー未設定 (開発) のときはコンソールに出すだけ。
export async function sendMail(
  env: { RESEND_API_KEY?: string; MAIL_FROM_ADDRESS?: string; MAIL_FROM_NAME?: string },
  m: { to: string; subject: string; text: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM_ADDRESS) {
    console.log(`[mail:dev] to=${m.to} subject=${m.subject}\n${m.text}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: `${env.MAIL_FROM_NAME ?? 'A-ONE CIRCUIT フォト'} <${env.MAIL_FROM_ADDRESS}>`,
      to: [m.to], subject: m.subject, text: m.text,
    }),
  });
  if (!res.ok) console.error('[mail] resend failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}
