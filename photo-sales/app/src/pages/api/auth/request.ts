import type { APIRoute } from 'astro';
import { issueLoginToken } from '@lib/auth.ts';
import { sendMail } from '@lib/mail.ts';
import { baseUrl, getDb, getEnv, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const f = await request.formData();
  const email = String(f.get('email') ?? '');
  const next = String(f.get('next') ?? '');
  const env = getEnv(locals);
  const token = await issueLoginToken(getDb(locals), email);
  let dev = '';
  if (token) {
    const q = `t=${token}${next.startsWith('/admin') ? `&next=${encodeURIComponent(next)}` : ''}`;
    const link = `${baseUrl(env, request)}/admin/verify?${q}`;
    await sendMail(env, {
      to: email.trim().toLowerCase(),
      subject: 'A-ONE フォト ログインリンク',
      text: `A-ONE CIRCUIT 写真管理へのログインリンクです (15分間有効・1回のみ)。\n\n${link}\n\n心当たりがない場合は、このメールを無視してください。`,
    });
    if (import.meta.env.DEV) dev = `&dev=${encodeURIComponent(link)}`;
  }
  // 登録の有無にかかわらず同じ画面 (メールアドレスの推測を防ぐ)
  return redirect(`/admin/login?sent=1${dev}`);
};
