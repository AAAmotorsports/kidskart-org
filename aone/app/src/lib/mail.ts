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
import { jaDate, timeRangeLabel, KIND_LABELS, STATUS_LABELS, hhmm } from './domain';

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

  const from = env.MAIL_FROM_ADDRESS || 'noreply@rk-a1.com';
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
    `📞 ${env.PUBLIC_SITE_TEL || '092-919-7186'}`,
    `✉️ ${env.MAIL_REPLY_TO || 'info@rk-a1.com'}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];
}

/**
 * 折り返しの電話が必要な状態か。
 * 連絡待ち (貸切で他予約あり) と 確認中 (ナイター / 17:00 以降の RP) は、
 * A-ONE から連絡しない限り話が進まない。見落とすと機会損失に直結するので、
 * 管理者宛メールの件名で目立たせ、お客様には未確定であることを明示する。
 */
function needsCallback(status: string): boolean {
  return status === 'contact_wait' || status === 'checking';
}

/** お客様への折り返し期限 (時間)。過ぎたら電話してくださいとご案内する */
const CALLBACK_HOURS = 48;

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
  '・ご連絡いただければ、当日でもキャンセル料はいただきません。',
  '・当日ご連絡のないキャンセル (無断キャンセル) は料金 100% を申し受けます。',
  '・日程・人数の変更は予約者専用ページからいつでも可能です。',
];

const CANCEL_POLICY_SPORT = [
  '▼ キャンセルについて',
  '・天候の影響が大きいため、当日でもご連絡いただければキャンセル可能です (キャンセル料なし)。',
  '・当日ご連絡のないキャンセル (無断キャンセル) は料金 100% を申し受けます。',
];

/** 予約直後の完了メール (仕様 11) */
export function confirmMail(env: Env, r: ReservationForMail, origin: string) {
  const pending = r.status !== 'confirmed';
  const tel = env.PUBLIC_SITE_TEL || '092-919-7186';
  const subject = pending
    ? `【まだ確定していません】ご予約の申込みを承りました — ${r.reservation_number}`
    : `【予約確定】${jaDate(r.date)} ${KIND_LABELS[r.kind as keyof typeof KIND_LABELS]} — ${r.reservation_number}`;

  const text = [
    `${r.contact_name} 様`,
    '',
    ...(pending
      ? [
          'ご予約の申込みを受付けました。',
          '',
          '■━━━━━━━━━━━━━━━━━━■',
          '  このご予約はまだ確定していません',
          '■━━━━━━━━━━━━━━━━━━■',
          '',
          `内容を確認のうえ、A-ONE より ${CALLBACK_HOURS} 時間以内に折り返しご連絡いたします。`,
          'ご連絡をもって確定となりますので、それまでご来場のご準備はお待ちください。',
          '',
          `※ ${CALLBACK_HOURS} 時間を過ぎても連絡がない場合は、お手数ですがお電話ください (${tel})。`,
        ]
      : ['ご予約が確定しました。当日のご来場をお待ちしております。']),
    '',
    '▼ ご予約内容',
    ...detailLines(r),
    `状態: ${pending ? STATUS_LABELS[r.status] ?? r.status : '確定'}`,
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
            '※ 当日ご連絡のないキャンセルのため、規定によりキャンセル料が発生します。',
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
/**
 * 折り返し待ちのまま放置されている予約の一覧 (管理者宛・1 日 1 通)
 *
 * 「連絡待ち」「確認中」は A-ONE から連絡しないと確定しない。
 * 受付直後の通知を見落としたときの最後の砦なので、経過時間と電話番号を
 * 目立つ形で並べる。
 */
export function pendingCallbackAlertMail(
  env: Env,
  rows: Array<{
    reservation_number: string; kind: string; status: string; date: string;
    start_time?: string | null; end_time?: string | null; party_size: number;
    contact_name: string; contact_phone?: string | null; contact_email?: string | null;
    request_note?: string | null; hours_waiting: number;
  }>,
  origin: string,
) {
  const worst = Math.max(...rows.map((r) => r.hours_waiting));
  return {
    subject: `🔴要折り返し ${rows.length} 件 (最長 ${worst} 時間経過) — A-ONE`,
    text: [
      `折り返しのご連絡がまだの予約が ${rows.length} 件あります。`,
      'いずれも A-ONE から連絡しないと確定しません。',
      '',
      ...rows.flatMap((r) => [
        '━━━━━━━━━━━━━━━━━━━━',
        `【${r.hours_waiting} 時間経過】${STATUS_LABELS[r.status] ?? r.status}`,
        `${r.contact_name} 様  📞 ${r.contact_phone ?? '電話なし'}`,
        `${KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind} / ${jaDate(r.date)} ` +
          `${hhmm(r.start_time)}${r.end_time ? '〜' + hhmm(r.end_time) : ''} / ${r.party_size} 名`,
        `予約番号: ${r.reservation_number}`,
        ...(r.contact_email ? [`メール: ${r.contact_email}`] : []),
        ...(r.request_note ? [`要望: ${r.request_note}`] : []),
        `${origin}/admin/day/${r.date}`,
      ]),
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      '対応したら、管理画面の「📞 電話で対応済」ボタンを押してください。',
      'このお知らせに出なくなります。',
      ...footer(env),
    ].join('\n'),
  };
}

export function adminNoticeMail(env: Env, r: ReservationForMail, origin: string) {
  const callback = needsCallback(r.status);
  const label = KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind;
  const statusJa = STATUS_LABELS[r.status] ?? r.status;

  return {
    // 件名の頭で「折り返しが要るか」が分かるようにする (受信箱で見落とさないため)
    subject: callback
      ? `🔴要折り返し [A-ONE] ${label} ${r.date} ${hhmm(r.start_time)} ${r.contact_name} 様 (${statusJa})`
      : `✅確定 [A-ONE] ${label} ${r.date} ${hhmm(r.start_time)} ${r.contact_name} 様`,
    text: [
      ...(callback
        ? [
            '🔴 このご予約は【要折り返し】です。A-ONE から連絡しないと確定しません。',
            `   お客様には「${CALLBACK_HOURS} 時間以内に折り返す」とご案内しています。`,
            `   お電話: ${r.contact_phone ?? '—'}`,
            '',
          ]
        : ['✅ 新しい予約が入りました (確定済み)。', '']),
      ...detailLines(r),
      `状態: ${statusJa}`,
      `お名前: ${r.contact_name}`,
      `電話: ${r.contact_phone ?? '—'}`,
      `メール: ${r.contact_email ?? '—'}`,
      '',
      `▼ 管理画面`,
      `${origin}/admin/day/${r.date}`,
    ].join('\n'),
  };
}
