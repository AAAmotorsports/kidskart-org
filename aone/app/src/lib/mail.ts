// メール送信 (Resend) と定型文面。
//
// 仕様 11「自動メール」で必要な 4 通:
//   予約直後  … 予約完了メール (変更・キャンセル URL 入り)
//   1 日前    … リマインド
//   利用当日  … 終了後のお礼
//   2 週間後  … 再来場を促すサンキュー (再予約リンク付き)
// に加えて、天候等の一括連絡 (仕様 8) と管理者宛て通知を扱う。
//
// RESEND_API_KEY が無い環境 (dev / 未設定) では送信をスキップして
// ログだけ残す (graceful degradation)。

import { getSupabaseAdmin } from './supabase';
import { jaDate, timeRangeLabel, KIND_LABELS, hhmm } from './domain';

export type MailKind = 'confirm' | 'reminder' | 'thanks' | 'followup' | 'broadcast' | 'cancel' | 'admin';

export interface ReservationForMail {
  id: string;
  reservation_number: string;
  kind: string;
  status: string;
  date: string;
  session?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  category_code?: string | null;
  party_size: number;
  contact_name: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  access_token: string;
  amount?: number | null;
}

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  kind: MailKind;
  reservationId?: string | null;
}

export async function sendMail(env: Env, args: SendArgs): Promise<boolean> {
  const to = (args.to ?? '').trim();
  if (!to) return false;

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || 'A-ONE サーキット';
  const replyTo = env.MAIL_REPLY_TO || undefined;

  let ok = true;
  let error: string | null = null;

  if (!env.RESEND_API_KEY) {
    console.warn('[mail] RESEND_API_KEY 未設定のため送信をスキップ:', args.subject, '→', to);
    ok = false;
    error = 'RESEND_API_KEY not configured';
  } else {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <${from}>`,
          to: [to],
          reply_to: replyTo,
          subject: args.subject,
          text: args.text,
        }),
      });
      if (!res.ok) {
        ok = false;
        error = `Resend ${res.status}: ${await res.text()}`;
        console.warn('[mail] 送信失敗', error);
      }
    } catch (e: any) {
      ok = false;
      error = String(e?.message ?? e);
      console.warn('[mail] 送信例外', error);
    }
  }

  // 送信ログ (失敗も残す — 天候一括連絡の到達確認に使う)
  try {
    await getSupabaseAdmin(env).from('aone_mail_log').insert({
      reservation_id: args.reservationId ?? null,
      kind: args.kind,
      to_email: to,
      subject: args.subject,
      ok,
      error,
    });
  } catch (e) {
    console.warn('[mail] ログ記録に失敗', e);
  }

  return ok;
}

// -----------------------------------------------------------------------------
// 文面
// -----------------------------------------------------------------------------

function footer(env: Env): string[] {
  return [
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    env.PUBLIC_SITE_NAME || 'A-ONE サーキット',
    `📞 ${env.PUBLIC_SITE_TEL || '092-927-1177'}`,
    `✉️ ${env.MAIL_REPLY_TO || 'info@kidskart.org'}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];
}

function detailLines(r: ReservationForMail): string[] {
  const lines = [
    `予約番号: ${r.reservation_number}`,
    `内容: ${KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind}`,
    `日付: ${jaDate(r.date)}`,
    `時間: ${timeRangeLabel(r)}`,
    `人数: ${r.party_size} 名`,
  ];
  if (r.amount != null) lines.push(`料金: ¥${r.amount.toLocaleString('ja-JP')} (現地でのお支払い)`);
  return lines;
}

function myPageUrl(origin: string, r: ReservationForMail): string {
  return `${origin}/r/${r.access_token}`;
}

const CANCEL_POLICY_RP = [
  '▼ キャンセル規定',
  '・ご利用開始 24 時間前以降のキャンセルは料金 100% を申し受けます。',
  '・日程・人数の変更は予約者専用ページからいつでも可能です。',
];

const CANCEL_POLICY_SPORT = [
  '▼ キャンセルについて',
  '・天候の影響が大きいため、当日でもご連絡いただければキャンセル可能です (キャンセル料なし)。',
  '・ご連絡のないキャンセルは無断キャンセルとして記録させていただきます。',
];

/** 予約直後の完了メール (仕様 11) */
export function confirmMail(env: Env, r: ReservationForMail, origin: string) {
  const pending = r.status !== 'confirmed';
  const subject = pending
    ? `【受付】ご予約を承りました — ${r.reservation_number}`
    : `【予約確定】${jaDate(r.date)} ${KIND_LABELS[r.kind as keyof typeof KIND_LABELS]} — ${r.reservation_number}`;

  const text = [
    `${r.contact_name} 様`,
    '',
    pending
      ? 'ご予約の申込みを受付けました。内容を確認のうえ、A-ONE より折り返しご連絡いたします。'
      : 'ご予約が確定しました。当日のご来場をお待ちしております。',
    '',
    '▼ ご予約内容',
    ...detailLines(r),
    '',
    '▼ ご予約内容の確認・変更・キャンセル',
    myPageUrl(origin, r),
    '(このページからいつでも日時・人数の変更ができます)',
    '',
    ...(r.kind === 'sport' ? CANCEL_POLICY_SPORT : CANCEL_POLICY_RP),
    '',
    '▼ 当日の営業状況',
    `${origin}/`,
    '(天候による営業判断は当日こちらでご確認いただけます)',
    ...footer(env),
  ].join('\n');

  return { subject, text };
}

/** 前日リマインド (仕様 11) */
export function reminderMail(env: Env, r: ReservationForMail, origin: string) {
  return {
    subject: `【明日のご予約】${jaDate(r.date)} — ${r.reservation_number}`,
    text: [
      `${r.contact_name} 様`,
      '',
      '明日のご予約についてご案内します。',
      '',
      ...detailLines(r),
      '',
      '▼ ご予約内容の確認・変更・キャンセル',
      myPageUrl(origin, r),
      '',
      '▼ 当日の営業状況 (天候判断)',
      `${origin}/`,
      '雨天等で営業状況が変わる場合は、こちらとメールでお知らせします。',
      ...footer(env),
    ].join('\n'),
  };
}

/** 利用当日 (走行終了後) のお礼 (仕様 11) */
export function thanksMail(env: Env, r: ReservationForMail, origin: string) {
  return {
    subject: '本日はありがとうございました',
    text: [
      `${r.contact_name} 様`,
      '',
      '本日は A-ONE サーキットをご利用いただきありがとうございました。',
      'お楽しみいただけましたでしょうか。',
      '',
      ...detailLines(r),
      '',
      '▼ 次回のご予約はこちら',
      `${origin}/reserve`,
      ...footer(env),
    ].join('\n'),
  };
}

/** 2 週間後のフォロー (仕様 11: 再来場促進) */
export function followupMail(env: Env, r: ReservationForMail, origin: string) {
  const link = r.kind === 'rp' ? `${origin}/reserve/rp` : `${origin}/reserve`;
  return {
    subject: 'またのご利用をお待ちしております — A-ONE サーキット',
    text: [
      `${r.contact_name} 様`,
      '',
      `先日 (${jaDate(r.date)}) は A-ONE サーキットをご利用いただきありがとうございました。`,
      'その後、走りの感触はいかがでしたか。',
      '',
      'A-ONE では、スポーツ走行・レースパック (3 名以上)・貸切走行を',
      '通年で受付けています。ご友人やご家族とのレースパックもおすすめです。',
      '',
      '▼ またのご利用はこちら',
      link,
      '',
      '▼ 本日走れるかどうかはこちら',
      `${origin}/`,
      ...footer(env),
    ].join('\n'),
  };
}

/** キャンセル完了通知 */
export function cancelMail(env: Env, r: ReservationForMail, origin: string, fee: boolean) {
  return {
    subject: `【キャンセル受付】${r.reservation_number}`,
    text: [
      `${r.contact_name} 様`,
      '',
      '下記のご予約をキャンセルしました。',
      '',
      ...detailLines(r),
      '',
      ...(fee
        ? [
            '※ ご利用開始 24 時間前以降のキャンセルのため、規定によりキャンセル料が発生します。',
            '　 詳細は A-ONE よりご連絡いたします。',
            '',
          ]
        : []),
      'またのご利用をお待ちしております。',
      `${origin}/reserve`,
      ...footer(env),
    ].join('\n'),
  };
}

/** 管理者宛ての新規予約通知 */
export function adminNoticeMail(env: Env, r: ReservationForMail, origin: string) {
  return {
    subject: `[A-ONE] 新規${KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind} ${r.date} ${hhmm(r.start_time)} ${r.contact_name} 様 (${r.status})`,
    text: [
      '新しい予約が入りました。',
      '',
      ...detailLines(r),
      `状態: ${r.status}`,
      `お名前: ${r.contact_name}`,
      `電話: ${r.contact_phone ?? '—'}`,
      `メール: ${r.contact_email ?? '—'}`,
      '',
      `▼ 管理画面`,
      `${origin}/admin/day/${r.date}`,
    ].join('\n'),
  };
}
