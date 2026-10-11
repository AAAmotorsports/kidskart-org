-- 0037_reservation_participant_cancelled_at.sql
--
-- reservation_participants.cancelled_at を追加。
--
-- 目的: 「予約全体のキャンセル」と「個別参加者キャンセル」を区別するため。
--   /api/admin/reservation-restore (誤キャンセル取消し) で、
--   "予約全体をキャンセルしたときに同時に cancelled された参加者" だけを
--   expected に戻し、"先に個別キャンセルされていた参加者" はそのまま
--   cancelled のままにしたい。
--
-- 従来は attendance_status しか無く、両者を区別できなかった。
-- cancelled_at を timestamptz で持ち、復活時は
--   WHERE cancelled_at >= reservations.cancelled_at
-- で「予約キャンセル時に同時に失われた参加者」だけを拾って戻す。
--
-- 既存の cancelled 行には NULL が入る (= 復活対象にしない安全側判定)。
-- アプリ側は以下を保証する:
--   (a) 新規キャンセル時は attendance_status='cancelled' と cancelled_at=now() を同時に書く
--   (b) 復活時は attendance_status='expected' + cancelled_at=NULL に戻す
--
-- 本 SQL の実行は アプリ deploy の 前/後 どちらでも可。
-- アプリ側は不在カラムでも graceful (undefined 扱い)。

alter table reservation_participants
  add column if not exists cancelled_at timestamptz;

comment on column reservation_participants.cancelled_at is
  'この参加者が cancelled 扱いになった時刻。復活時に「予約全体キャンセルに巻き込まれたか / それ以前の個別キャンセルか」を区別するために使う。';

create index if not exists idx_rp_cancelled_at
  on reservation_participants(cancelled_at)
  where cancelled_at is not null;
