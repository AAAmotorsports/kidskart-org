-- =============================================================================
-- 「このカテゴリーだけ走れる」予定
-- =============================================================================
-- 2026-08 オーナー要望 (レース前日の運用):
--
--   カートはそのまま走らせたい。ミニバイク等は弾きたい。
--
-- 今の停止範囲では表せなかった:
--   scope='sport'    … スポーツ走行を全部止める (カートも止まる)
--   scope='category' … 指定した 1 カテゴリーだけ止める
--                      → ミニバイク・キッズカート・その他 と 3 件登録が必要。
--                        カテゴリーが増えたら足し忘れる
--
-- そこで逆向きの指定を足す:
--   scope='only_category' … allow_categories に入れたカテゴリーだけ受け付け、
--                           ほかのスポーツ走行は止める
--
-- 「1 件登録すれば以後カテゴリーが増えても自動的に止まる」ほうが、
-- 走行枠の事故 (止めたいものが走れてしまう) を起こしにくい。
--
-- ★ すでに入っている予約は、あとから予定を足しても消えない。
--   ブロックが効くのは「これから受ける予約」だけ (aone_check_availability)。
--   だから「先に停止してから強制で入れ直す」必要はない。
-- =============================================================================

alter table aone_blocks
  add column if not exists allow_categories text[] not null default '{}';

comment on column aone_blocks.allow_categories is
  'scope=only_category のとき、走行を許すカテゴリー。ここに無いものは止める';

alter table aone_blocks drop constraint if exists aone_blocks_scope_check;
alter table aone_blocks add constraint aone_blocks_scope_check
  check (scope in ('all', 'am', 'pm', 'time', 'sport', 'rp', 'category', 'only_category'));

-- -----------------------------------------------------------------------------
-- 受付判定に only_category を足す
-- -----------------------------------------------------------------------------
create or replace function aone_blocking_blocks(
  p_date     date,
  p_kind     text,
  p_category text,
  p_start    time,
  p_end      time
)
returns table (id uuid, title text, kind text, scope text)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  win as (
    select b.*,
      case b.scope
        when 'am'   then (select course_open_time from s)
        when 'pm'   then (select pm_start_time    from s)
        when 'time' then coalesce(b.start_time, time '00:00')
        else coalesce(b.start_time, time '00:00')
      end as w_start,
      case b.scope
        when 'am'   then (select am_end_time       from s)
        when 'pm'   then (select course_close_time from s)
        when 'time' then coalesce(b.end_time, time '23:59:59')
        else coalesce(b.end_time, time '23:59:59')
      end as w_end
    from aone_blocks b
    where b.date = p_date
  )
  select w.id, w.title, w.kind, w.scope
  from win w
  where
    -- 対象の予約種別に効くか
    case
      when w.scope = 'sport'    then p_kind = 'sport'
      when w.scope = 'rp'       then p_kind = 'rp'
      when w.scope = 'category' then p_kind = 'sport'
                                  and (w.category_code is null or w.category_code = p_category)
      -- 許可したカテゴリー以外のスポーツ走行を止める。
      -- 許可が空のときは何も止めない (登録し忘れで全部止まると事故になる)
      when w.scope = 'only_category' then p_kind = 'sport'
                                  and array_length(w.allow_categories, 1) is not null
                                  and not (p_category = any (w.allow_categories))
      else
        case p_kind
          when 'sport'   then w.blocks_sport
          when 'night'   then w.blocks_sport
          when 'rp'      then w.blocks_rp
          when 'charter' then w.blocks_charter
          else true
        end
    end
    -- 時間帯が重なるか (時刻未指定のブロックは終日扱い)
    and w.w_start < coalesce(p_end, time '23:59:59')
    and w.w_end   > coalesce(p_start, time '00:00');
$$;

alter function aone_blocking_blocks(date, text, text, time, time)
  security definer set search_path = public, pg_temp;
grant execute on function aone_blocking_blocks(date, text, text, time, time)
  to anon, authenticated, service_role;
