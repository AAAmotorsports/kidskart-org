// メール送信 (Resend) と定型文面。
//
// 仕様 11「自動メール」で必要な 4 通:
//   予約直後  … 予約完了メール (変更・キャンセル URL 入り)
//   1 日前    … リマインド
//   利用当日  … 終了後のお礼
//   3 か月後  … 再来場を促すサンキュー (再予約リンク付き)
// に加えて、天候等の一括連絡 (仕様 8) と管理者宛て通知を扱う。
//
// RESEND_API_KEY が無い環境 (dev / 未設定) では送信をスキップして
// ログだけ残す (graceful degradation)。

import { getSupabaseAdmin } from './supabase';
import {
  jaDate, timeRangeLabel, KIND_LABELS, STATUS_LABELS, CHARTER_TYPE_LABELS, hhmm,
  nameWithHonorific, stripHonorific, entryPersonLabel,
} from './domain';

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
  /** ナイターの内訳 (rp / charter) */
  night_kind?: string | null;
  /** 貸切の種別 (with_karts / course_only) */
  charter_type?: string | null;
  party_size: number;
  /** 貸切で使うカートの台数 */
  vehicle_count?: number | null;
  /** お客様が入力したご要望・ご相談内容 */
  request_note?: string | null;
  contact_name: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  access_token: string;
  amount?: number | null;
  /**
   * カテゴリーの表示名 (ミニバイク等)。category_code から辿ったもの。
   * これが無いとスポーツ走行のメールに車両の種類が載らず、
   * 「カート: 1 台」だけが目に入って**カートを予約したように読める**
   * (2026-09 オーナー指摘: ミニバイクで予約したのにカートで届いた)。
   */
  aone_categories?: { name?: string | null } | null;
}

/**
 * メール文面に必要な列。予約作成・キャンセル・cron のどこから送っても
 * 同じ情報が載るように、SELECT はこの 1 か所にまとめる
 * (台数や要望が片方のメールにだけ載らない、という事故を防ぐため)。
 */
export const MAIL_COLUMNS =
  'id,reservation_number,kind,status,date,session,start_time,end_time,category_code,' +
  'night_kind,charter_type,party_size,vehicle_count,request_note,contact_name,contact_email,contact_phone,' +
  'access_token,amount,aone_categories(name)';

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  kind: MailKind;
  reservationId?: string | null;
  /** 添付ファイル (月次バックアップの CSV など) */
  attachments?: Array<{ filename: string; content: string }>;
}

/** UTF-8 の文字列を base64 に (Workers に Buffer は無い) */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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
          // Resend は添付を base64 で受け取る
          attachments: args.attachments?.map((a) => ({
            filename: a.filename,
            content: toBase64(a.content),
          })),
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

/** カテゴリーの表示名。取れなければコードをそのまま (空なら null)。 */
function categoryName(r: ReservationForMail): string | null {
  return r.aone_categories?.name || r.category_code || null;
}

/** 貸切かどうか (ナイターの貸切を含む)。台数の呼び方を分けるのに使う。 */
function isCharter(r: ReservationForMail): boolean {
  return r.kind === 'charter' || (r.kind === 'night' && r.night_kind === 'charter');
}

function detailLines(r: ReservationForMail): string[] {
  const lines = [
    `予約番号: ${r.reservation_number}`,
    `内容: ${KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind}` +
      (r.kind === 'night' && r.night_kind
        ? ` (${KIND_LABELS[r.night_kind as keyof typeof KIND_LABELS] ?? r.night_kind})`
        : '') +
      (r.charter_type ? ` (${CHARTER_TYPE_LABELS[r.charter_type] ?? r.charter_type})` : ''),
    `日付: ${jaDate(r.date)}`,
    `時間: ${timeRangeLabel(r)}`,
    `人数: ${r.party_size} 名`,
  ];
  // スポーツ走行は「何で走るか」がいちばん大事。これを出さないと、
  // 下の台数と合わせて「カートの予約」に見えてしまう
  const cat = categoryName(r);
  if (cat) lines.push(`車両: ${cat}`);
  // 貸切 (ナイターの貸切を含む) は台数で料金が変わるので必ず出す。
  // スポーツ走行の台数は「持ち込む車両の数」なのでカートとは書かない
  if (r.vehicle_count != null) {
    lines.push(isCharter(r) ? `カート: ${r.vehicle_count} 台` : `台数: ${r.vehicle_count} 台`);
  }
  if (r.amount != null) lines.push(`料金: ¥${r.amount.toLocaleString('ja-JP')} (現地でのお支払い)`);
  if ((r.request_note ?? '').trim()) lines.push(`ご要望: ${r.request_note!.trim()}`);
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
    `${nameWithHonorific(r.contact_name)}`,
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
      `${nameWithHonorific(r.contact_name)}`,
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
      `${nameWithHonorific(r.contact_name)}`,
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

/**
 * 3 か月後のフォロー (仕様 11: 再来場促進 / 2026-08 オーナー確認)。
 *
 * 以前は 2 週間後に送っていたが、レンタルカートで遊びに来る方の
 * 次の機会はもっと先。3 か月おきに 1 通のほうが「そろそろまた」に効く。
 */
export function followupMail(env: Env, r: ReservationForMail, origin: string) {
  const link = r.kind === 'rp' ? `${origin}/reserve/rp` : `${origin}/reserve`;
  return {
    subject: 'またのご利用をお待ちしております — A-ONE サーキット',
    text: [
      `${nameWithHonorific(r.contact_name)}`,
      '',
      `${jaDate(r.date)} は A-ONE サーキットをご利用いただきありがとうございました。`,
      'あれから 3 か月が経ちました。またご一緒に走りませんか。',
      '',
      'レースパック (3 名以上) は、練習 → 予選 → 決勝レースまでを',
      'ひととおり楽しめます。貸切走行も承っています。',
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
      `${nameWithHonorific(r.contact_name)}`,
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
/**
 * 予約内容が変わったときのお知らせ (仕様 10)
 *
 * お客様が専用ページで変更した場合と、スタッフが管理画面で変更した場合の
 * 両方で使う。「誰が変えたか」ではなく「今どうなっているか」を伝える。
 */
export function changeMail(env: Env, r: ReservationForMail, origin: string) {
  const pending = r.status !== 'confirmed';
  return {
    subject: `【ご予約内容の変更】${jaDate(r.date)} — ${r.reservation_number}`,
    text: [
      `${nameWithHonorific(r.contact_name)}`,
      '',
      'ご予約の内容を変更しました。下記のとおりお受けしています。',
      '',
      '▼ 変更後のご予約内容',
      ...detailLines(r),
      `状態: ${pending ? STATUS_LABELS[r.status] ?? r.status : '確定'}`,
      '',
      ...(pending
        ? ['この内容はまだ確定していません。A-ONE より折り返しご連絡いたします。', '']
        : []),
      '▼ ご予約内容の確認・変更・キャンセル',
      myPageUrl(origin, r),
      '',
      'お心当たりのない変更の場合は、お手数ですがご連絡ください。',
      ...footer(env),
    ].join('\n'),
  };
}

/**
 * お客様が予約者ページから内容を変更したときの管理者宛通知
 *
 * 「何がどう変わったか」が分からないと、席の空き・用意する台数の判断ができない。
 * 変更前と変更後を並べて出す。
 */
export function adminChangeMail(
  env: Env,
  before: ReservationForMail,
  after: ReservationForMail,
  origin: string,
) {
  const label = KIND_LABELS[after.kind as keyof typeof KIND_LABELS] ?? after.kind;

  const diffs: string[] = [];
  const add = (name: string, a: unknown, b: unknown) => {
    if (String(a ?? '—') !== String(b ?? '—')) diffs.push(`${name}: ${a ?? '—'} → ${b ?? '—'}`);
  };
  // 名前が変わったら受付シートを刷り直すことになるので、いちばん上に出す
  add('お名前', before.contact_name, after.contact_name);
  add('日付', jaDate(before.date), jaDate(after.date));
  add('時間', timeRangeLabel(before), timeRangeLabel(after));
  add('人数', `${before.party_size} 名`, `${after.party_size} 名`);
  add(isCharter(after) ? 'カート台数' : '台数',
      before.vehicle_count ? `${before.vehicle_count} 台` : null,
      after.vehicle_count ? `${after.vehicle_count} 台` : null);
  add('車両', categoryName(before), categoryName(after));
  add('金額', before.amount != null ? `¥${before.amount.toLocaleString('ja-JP')}` : null,
      after.amount != null ? `¥${after.amount.toLocaleString('ja-JP')}` : null);
  add('状態', STATUS_LABELS[before.status] ?? before.status, STATUS_LABELS[after.status] ?? after.status);

  return {
    subject: `✏️変更 [A-ONE] ${label} ${after.date} ${hhmm(after.start_time)} ${nameWithHonorific(after.contact_name)}`,
    text: [
      'お客様が予約者ページからご予約内容を変更しました。',
      '',
      '▼ 変更点',
      ...(diffs.length ? diffs.map((d) => `・${d}`) : ['・(内容の変更はありません)']),
      '',
      '▼ 変更後のご予約内容',
      ...detailLines(after),
      `状態: ${STATUS_LABELS[after.status] ?? after.status}`,
      `お名前: ${after.contact_name}`,
      `電話: ${after.contact_phone ?? '—'}`,
      `メール: ${after.contact_email ?? '—'}`,
      '',
      '▼ 管理画面',
      `${origin}/admin/day/${after.date}`,
      ...(before.date !== after.date ? [`(変更前の日: ${origin}/admin/day/${before.date})`] : []),
    ].join('\n'),
  };
}

/** お客様が予約者ページからキャンセルしたときの管理者宛通知 */
export function adminCancelMail(env: Env, r: ReservationForMail, origin: string) {
  const label = KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind;
  return {
    subject: `❌キャンセル [A-ONE] ${label} ${r.date} ${hhmm(r.start_time)} ${nameWithHonorific(r.contact_name)}`,
    text: [
      'お客様が予約者ページからキャンセルしました。枠が空きます。',
      '',
      ...detailLines(r),
      `お名前: ${r.contact_name}`,
      `電話: ${r.contact_phone ?? '—'}`,
      `メール: ${r.contact_email ?? '—'}`,
      '',
      '▼ 管理画面',
      `${origin}/admin/day/${r.date}`,
    ].join('\n'),
  };
}

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
        `${nameWithHonorific(r.contact_name)}  📞 ${r.contact_phone ?? '電話なし'}`,
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
      ? `🔴要折り返し [A-ONE] ${label} ${r.date} ${hhmm(r.start_time)} ${nameWithHonorific(r.contact_name)} (${statusJa})`
      : `✅確定 [A-ONE] ${label} ${r.date} ${hhmm(r.start_time)} ${nameWithHonorific(r.contact_name)}`,
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

// -----------------------------------------------------------------------------
// イベントの参加申込 (エントリー)
// -----------------------------------------------------------------------------
// 走行の予約とは別台帳なので、テンプレートも別に持つ。
// 予約と同じ「お客様に控え / 管理者に通知」の 2 通構成。

export const ENTRY_COLUMNS_MAIL =
  'id,entry_number,date,event_title,entry_type,status,team_name,' +
  'contact_name,contact_kana,contact_email,contact_phone,' +
  'frame_maker,number_wish,race_class,amount,note,access_token';

export interface EntryForMail {
  id: string;
  entry_number: string;
  date: string;
  event_title: string;
  entry_type: string;
  status: string;
  team_name: string | null;
  contact_name: string;
  contact_kana: string | null;
  contact_email: string;
  contact_phone: string;
  frame_maker: string | null;
  number_wish: string | null;
  race_class: string | null;
  amount: number | null;
  note: string | null;
  access_token: string;
}

function entryLines(e: EntryForMail): string[] {
  const lines = [
    `申込番号: ${e.entry_number}`,
    `イベント: ${e.event_title}`,
    `開催日: ${jaDate(e.date)}`,
    `チーム名: ${e.team_name ?? '—'}`,
    // 明細の行なので敬称は付けない。入力に「様」が入っていても落とす
    `${entryPersonLabel(e.entry_type)}: ${stripHonorific(e.contact_name)}`,
  ];
  if (e.contact_kana) lines.push(`ふりがな: ${e.contact_kana}`);
  if (e.race_class) lines.push(`参加クラス: ${e.race_class}`);
  if (e.frame_maker) lines.push(`フレームメーカー: ${e.frame_maker}`);
  if (e.number_wish) lines.push(`希望ゼッケン: ${e.number_wish}`);
  lines.push(
    e.amount != null
      ? `参加費: ¥${e.amount.toLocaleString('ja-JP')}`
      : '参加費: 追ってご案内します',
  );
  if (e.note) lines.push(`ご連絡事項: ${e.note}`);
  return lines;
}

/** 申込を受け付けたことをお客様に伝える控え */
export function entryMail(env: Env, e: EntryForMail, origin: string) {
  return {
    subject: `【参加申込を受け付けました】${e.event_title} (${jaDate(e.date)})`,
    text: [
      nameWithHonorific(e.contact_name),
      '',
      'イベントの参加申込を受け付けました。ありがとうございます。',
      '',
      '▼ お申込内容',
      ...entryLines(e),
      '',
      // 参加案内 (集合時間・組み合わせ等) は A-ONE 側が個別に送る。
      // 「これで完了なのか」が分からないと問い合わせが増えるので、先に書く。
      '━━━━━━━━━━━━━━━━━━━━',
      'このあとの流れ',
      '━━━━━━━━━━━━━━━━━━━━',
      '・受付内容を確認のうえ、A-ONE より参加のご案内をお送りします。',
      '・当日の集合時間・タイムスケジュールもそちらでご連絡します。',
      '・ご不明な点、内容の変更・取り消しはお電話でご連絡ください。',
      '',
      '▼ 当日の営業状況',
      `${origin}/`,
      ...footer(env),
    ].join('\n'),
  };
}

/** 参加申込が入ったことを管理者に知らせる */
export function adminEntryMail(env: Env, e: EntryForMail, origin: string) {
  return {
    subject: `🎫申込 [A-ONE] ${e.event_title} ${e.date} ${nameWithHonorific(e.contact_name)}`,
    text: [
      'イベントの参加申込が入りました。',
      '',
      ...entryLines(e),
      `お電話: ${e.contact_phone}`,
      `メール: ${e.contact_email}`,
      '',
      '▼ 管理画面 (申込一覧)',
      `${origin}/admin/entries?date=${e.date}`,
      ...footer(env),
    ].join('\n'),
  };
}
