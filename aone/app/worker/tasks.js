/**
 * cron が「その時刻に何を回すか」だけを決める。
 *
 * Astro のバンドルを読み込まずにテストできるよう、worker/index.js から分けてある
 * (index.js を import すると cloudflare:* が要るので Node からは読めない)。
 */

/**
 * @param hourJst       JST の時 (0〜23)
 * @param dayOfMonthJst JST の日
 * @returns 叩くパスの配列
 *
 * 毎時 1 本の cron で回し、中で振り分ける。cron の本数を増やさずに済み、
 * 「1 回落ちても次の回で拾う」形にしやすい。
 *
 * 二重送信は DB 側 (aone_reservations.*_mail_sent_at) で止まるので、
 * 同じ仕事を 1 日に 2 回呼んでも 2 通目は飛ばない。
 */
export function tasksFor(hourJst, dayOfMonthJst) {
  const tasks = [];

  // 朝の回 — 明日のご予約へのリマインド / 3 か月後のフォロー / 折り返しの督促
  if (hourJst === 8) {
    tasks.push('/api/cron/mails?type=reminder');
    tasks.push('/api/cron/mails?type=followup');
    tasks.push('/api/cron/mails?type=callbacks');
  }

  // 昼の回 — 朝が落ちたときのリマインドの拾い直し。
  // リマインドは「明日のご予約」なので、翌日に回すともう届けられない
  if (hourJst === 12) {
    tasks.push('/api/cron/mails?type=reminder');
  }

  // 夕の回 — 走行が終わってからお礼を送る
  if (hourJst === 18) {
    tasks.push('/api/cron/mails?type=thanks');
  }

  // 毎月 1 日の朝 — 予約台帳・顧客名簿・参加申込の CSV を管理者へ
  if (dayOfMonthJst === 1 && hourJst === 9) {
    tasks.push('/api/cron/backup');
  }

  return tasks;
}

/**
 * cron が起きた時刻 (ミリ秒) から、その回にやることを組み立てる。
 *
 * JST への読み替えとログの見出しもここで作る。worker/index.js 側は
 * これを呼んで叩くだけにしてあり、時刻まわりを Node から丸ごと試せる。
 *
 * @param scheduledTimeMs ScheduledEvent.scheduledTime
 */
export function planFor(scheduledTimeMs) {
  // Workers の時計は UTC。JST に直してから時・日を見る
  const jst = new Date(scheduledTimeMs + 9 * 60 * 60 * 1000);
  const hour = jst.getUTCHours();
  const day = jst.getUTCDate();
  return {
    hour,
    day,
    stamp: jst.toISOString().slice(0, 16).replace('T', ' '),
    tasks: tasksFor(hour, day),
  };
}
