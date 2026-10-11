-- =============================================================================
-- 自動メールから予約が入ったかを数えられるようにする
-- =============================================================================
-- 「リマインドメールで予約入ってないかな？」(2026-10 オーナー) に答えられなかった。
-- 予約に残るのは source (web / 電話 / 店頭 / 管理) だけで、メールの中のリンクにも
-- 目印が無く、**自動メール経由の予約をふだんの Web 予約と区別できなかった**。
--
-- やること:
--   1. aone_reservations.referrer … どこから来たか (?from=followup など)
--   2. aone_create_reservation が payload の referrer を保存する
--   3. aone_mail_effect() … 送信数と、そこから入った予約数をまとめて返す
--
-- ★ 値は check 制約で縛る。URL のパラメータが素通りするので、
--   勝手な文字列を入れられると集計が汚れる (アプリ側でも whitelist している)
-- =============================================================================

alter table aone_reservations
  add column if not exists referrer text;

do $$ begin
  alter table aone_reservations
    add constraint aone_reservations_referrer_check
    check (referrer is null or referrer in
      ('followup', 'thanks', 'reminder', 'widget', 'schedule'));
exception when duplicate_object then null;
end $$;

comment on column aone_reservations.referrer is
  'お客様がどこから来たか。自動メールのリンクに付けた ?from= を記録する。'
  '入力経路 (source) とは別軸 — source=web のまま referrer=followup になる';

create index if not exists aone_reservations_referrer_idx
  on aone_reservations (referrer) where referrer is not null;

-- -----------------------------------------------------------------------------
-- 予約作成: referrer を保存する (ほかは変更なし)
-- -----------------------------------------------------------------------------
create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null,
    nullif(payload->>'vehicle_count', '')::int,
    nullif(payload->>'charter_type', ''));

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code, night_kind,
    charter_type, party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by, referrer
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    nullif(payload->>'night_kind', ''),
    nullif(payload->>'charter_type', ''),
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', ''),
    -- どこから来たか。知らない値は捨てる (check 制約で落とすと予約ごと失敗する)
    case when payload->>'referrer' in ('followup','thanks','reminder','widget','schedule')
      then payload->>'referrer' else null end
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'night_kind', v_row.night_kind,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

revoke all on function aone_create_reservation(jsonb) from public, anon, authenticated;
grant execute on function aone_create_reservation(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 自動メールの効き目をまとめて返す
-- -----------------------------------------------------------------------------
-- 送信数は aone_mail_log、そこから入った予約数は aone_reservations.referrer。
-- ★ 2 か所に同じ数字を持たない。どちらも元の表から数え直す
--
-- 返す形:
--   { "days": 90, "since": "2026-07-13",
--     "mails":  [{"kind":"followup","sent":12,"failed":0}, ...],
--     "booked": [{"referrer":"followup","count":3,"people":11,"amount":72600}, ...] }
create or replace function aone_mail_effect(p_days integer default 90)
returns jsonb
language sql stable as $$
  with span as (
    -- 1〜365 日に収める。うっかり巨大な値で全件走査させない
    select (now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 365)))) as t0
  ),
  mails as (
    select m.kind,
           count(*) filter (where m.ok)       as sent,
           count(*) filter (where not m.ok)   as failed
    from aone_mail_log m, span
    where m.created_at >= span.t0
      -- お客様に送る自動メールだけ。管理者向け・一括連絡は対象外
      and m.kind in ('reminder', 'thanks', 'followup')
    group by m.kind
  ),
  booked as (
    select r.referrer,
           count(*)                                   as count,
           coalesce(sum(r.party_size), 0)             as people,
           coalesce(sum(r.amount), 0)                 as amount
    from aone_reservations r, span
    where r.referrer is not null
      and r.created_at >= span.t0
      -- 取り消したものは成果に数えない
      and aone_is_live(r.status)
    group by r.referrer
  )
  select jsonb_build_object(
    'days',  greatest(1, least(coalesce(p_days, 90), 365)),
    'since', to_char((select t0 from span) at time zone 'Asia/Tokyo', 'YYYY-MM-DD'),
    'mails', coalesce((select jsonb_agg(jsonb_build_object(
                'kind', kind, 'sent', sent, 'failed', failed) order by kind) from mails),
              '[]'::jsonb),
    'booked', coalesce((select jsonb_agg(jsonb_build_object(
                'referrer', referrer, 'count', count,
                'people', people, 'amount', amount) order by count desc) from booked),
              '[]'::jsonb)
  );
$$;

alter function aone_mail_effect(integer) security definer set search_path = public, pg_temp;
revoke all on function aone_mail_effect(integer) from public, anon, authenticated;
grant execute on function aone_mail_effect(integer) to service_role;
