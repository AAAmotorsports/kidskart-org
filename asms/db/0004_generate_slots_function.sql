-- =========================================================================
-- 0004_generate_slots_function.sql
-- -------------------------------------------------------------------------
-- Server-side slot generator. Given a target month, walks every calendar
-- day, matches it against schedule_rules (weekday bitmask), and returns
-- what would be created — either as a dry-run preview or as an actual
-- INSERT into slots.
--
-- weekday_mask bit assignment (matches 0001):
--   1=月(Mon) 2=火 4=水 8=木 16=金 32=土(Sat) 64=日(Sun) 128=祝(Holiday)
--
-- Postgres extract(dow) returns 0=Sun … 6=Sat. Holidays (128) are not
-- computed here; add them via schedule_exceptions.type = 'holiday' when
-- needed, or extend this function with a jp_holidays lookup later.
--
-- schedule_exceptions handling:
--   type='closure'    → whole day suppressed
--   type='challenge'  → the challenge slot is added AND non-blocks_morning
--                       slots before 12:00 are suppressed for that date
--   type='event'      → an extra single slot at the given time is added
--   type='extra_slot' → an extra slot on top of whatever rules produce
--
-- Return columns describe what happened per candidate slot so the admin
-- UI can render a diff table before committing.
-- =========================================================================

CREATE OR REPLACE FUNCTION generate_slots_for_month(
  p_year int,
  p_month int,
  p_dry_run bool DEFAULT true
) RETURNS TABLE (
  action        text,
  slot_date     date,
  weekday       text,
  start_time    time,
  end_time      time,
  course_code   text,
  course_name   text,
  capacity      int,
  reason        text
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  first_of_month date;
  last_of_month  date;
  d              date;
  dow_num        int;
  mask_bit       int;
  is_closed      bool;
  is_challenge   bool;
  challenge_ex   record;
  event_ex       record;
  extra_ex       record;
  rule           record;
  computed_end   time;
  weekday_ja     text;
BEGIN
  first_of_month := make_date(p_year, p_month, 1);
  last_of_month  := (first_of_month + INTERVAL '1 month' - INTERVAL '1 day')::date;

  FOR d IN
    SELECT gs::date
    FROM generate_series(first_of_month, last_of_month, INTERVAL '1 day') gs
  LOOP
    dow_num := EXTRACT(dow FROM d)::int;
    mask_bit := CASE dow_num
      WHEN 0 THEN 64  -- Sun
      WHEN 1 THEN 1   -- Mon
      WHEN 2 THEN 2
      WHEN 3 THEN 4
      WHEN 4 THEN 8
      WHEN 5 THEN 16
      WHEN 6 THEN 32  -- Sat
    END;
    weekday_ja := (ARRAY['日','月','火','水','木','金','土'])[dow_num + 1];

    is_closed    := EXISTS (SELECT 1 FROM schedule_exceptions WHERE date = d AND type = 'closure');
    is_challenge := EXISTS (SELECT 1 FROM schedule_exceptions WHERE date = d AND type = 'challenge');

    IF is_closed THEN
      action      := 'skipped_closure';
      slot_date   := d;
      weekday     := weekday_ja;
      start_time  := NULL;
      end_time    := NULL;
      course_code := NULL;
      course_name := NULL;
      capacity    := NULL;
      reason      := '休業日設定のため終日スキップ';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Regular rule-driven slots
    FOR rule IN
      SELECT sr.start_time, sr.capacity AS rule_capacity,
             c.id AS course_id, c.code, c.name,
             c.duration_min, c.default_capacity, c.blocks_morning
      FROM schedule_rules sr
      JOIN courses c ON c.id = sr.course_id
      WHERE sr.is_active
        AND (sr.effective_from IS NULL OR sr.effective_from <= d)
        AND (sr.effective_to   IS NULL OR sr.effective_to   >= d)
        AND (sr.weekday_mask & mask_bit) > 0
      ORDER BY sr.start_time
    LOOP
      computed_end := (rule.start_time + (rule.duration_min || ' minutes')::interval)::time;

      -- Suppress non-blocks_morning slots before 12:00 on challenge days
      IF is_challenge AND NOT rule.blocks_morning AND rule.start_time < TIME '12:00' THEN
        action      := 'skipped_challenge_morning';
        slot_date   := d;
        weekday     := weekday_ja;
        start_time  := rule.start_time;
        end_time    := computed_end;
        course_code := rule.code;
        course_name := rule.name;
        capacity    := COALESCE(rule.rule_capacity, rule.default_capacity);
        reason      := 'チャレンジ日午前枠を抑止';
        RETURN NEXT;
        CONTINUE;
      END IF;

      -- Already exists?
      IF EXISTS (
        SELECT 1 FROM slots
        WHERE date = d
          AND start_time = rule.start_time
          AND course_id = rule.course_id
      ) THEN
        action      := 'skipped_exists';
        slot_date   := d;
        weekday     := weekday_ja;
        start_time  := rule.start_time;
        end_time    := computed_end;
        course_code := rule.code;
        course_name := rule.name;
        capacity    := COALESCE(rule.rule_capacity, rule.default_capacity);
        reason      := '既に存在';
        RETURN NEXT;
        CONTINUE;
      END IF;

      IF NOT p_dry_run THEN
        INSERT INTO slots (date, start_time, end_time, course_id, capacity, generated_from_rule, status)
        VALUES (d, rule.start_time, computed_end, rule.course_id,
                COALESCE(rule.rule_capacity, rule.default_capacity),
                true, 'open');
        action := 'created';
      ELSE
        action := 'would_create';
      END IF;

      slot_date   := d;
      weekday     := weekday_ja;
      start_time  := rule.start_time;
      end_time    := computed_end;
      course_code := rule.code;
      course_name := rule.name;
      capacity    := COALESCE(rule.rule_capacity, rule.default_capacity);
      reason      := NULL;
      RETURN NEXT;
    END LOOP;

    -- Explicit challenge slot on challenge days
    FOR challenge_ex IN
      SELECT se.start_time, se.capacity AS ex_capacity, se.course_id, se.title,
             c.code, c.name, c.duration_min, c.default_capacity
      FROM schedule_exceptions se
      JOIN courses c ON c.id = se.course_id
      WHERE se.date = d AND se.type = 'challenge'
    LOOP
      computed_end := (challenge_ex.start_time
                      + (challenge_ex.duration_min || ' minutes')::interval)::time;

      IF EXISTS (SELECT 1 FROM slots WHERE date = d
                  AND start_time = challenge_ex.start_time
                  AND course_id = challenge_ex.course_id) THEN
        action := 'skipped_exists';
      ELSE
        IF NOT p_dry_run THEN
          INSERT INTO slots (date, start_time, end_time, course_id, capacity, generated_from_rule, status, note)
          VALUES (d, challenge_ex.start_time, computed_end, challenge_ex.course_id,
                  COALESCE(challenge_ex.ex_capacity, challenge_ex.default_capacity),
                  false, 'open', challenge_ex.title);
          action := 'created';
        ELSE
          action := 'would_create';
        END IF;
      END IF;

      slot_date   := d;
      weekday     := weekday_ja;
      start_time  := challenge_ex.start_time;
      end_time    := computed_end;
      course_code := challenge_ex.code;
      course_name := COALESCE(challenge_ex.title, challenge_ex.name);
      capacity    := COALESCE(challenge_ex.ex_capacity, challenge_ex.default_capacity);
      reason      := 'チャレンジ日設定';
      RETURN NEXT;
    END LOOP;

    -- Special event slots (サマースクール等)
    FOR event_ex IN
      SELECT se.start_time, se.capacity AS ex_capacity, se.course_id, se.title,
             c.code, c.name, c.duration_min, c.default_capacity
      FROM schedule_exceptions se
      JOIN courses c ON c.id = se.course_id
      WHERE se.date = d AND se.type = 'event'
    LOOP
      computed_end := (event_ex.start_time + (event_ex.duration_min || ' minutes')::interval)::time;

      IF EXISTS (SELECT 1 FROM slots WHERE date = d
                  AND start_time = event_ex.start_time
                  AND course_id = event_ex.course_id) THEN
        action := 'skipped_exists';
      ELSE
        IF NOT p_dry_run THEN
          INSERT INTO slots (date, start_time, end_time, course_id, capacity, generated_from_rule, status, note)
          VALUES (d, event_ex.start_time, computed_end, event_ex.course_id,
                  COALESCE(event_ex.ex_capacity, event_ex.default_capacity),
                  false, 'open', event_ex.title);
          action := 'created';
        ELSE
          action := 'would_create';
        END IF;
      END IF;

      slot_date   := d;
      weekday     := weekday_ja;
      start_time  := event_ex.start_time;
      end_time    := computed_end;
      course_code := event_ex.code;
      course_name := COALESCE(event_ex.title, event_ex.name);
      capacity    := COALESCE(event_ex.ex_capacity, event_ex.default_capacity);
      reason      := '特別イベント';
      RETURN NEXT;
    END LOOP;

    -- Extra slots (one-off additions on days that already have rule-driven slots)
    FOR extra_ex IN
      SELECT se.start_time, se.capacity AS ex_capacity, se.course_id, se.title,
             c.code, c.name, c.duration_min, c.default_capacity
      FROM schedule_exceptions se
      JOIN courses c ON c.id = se.course_id
      WHERE se.date = d AND se.type = 'extra_slot'
    LOOP
      computed_end := (extra_ex.start_time + (extra_ex.duration_min || ' minutes')::interval)::time;

      IF EXISTS (SELECT 1 FROM slots WHERE date = d
                  AND start_time = extra_ex.start_time
                  AND course_id = extra_ex.course_id) THEN
        action := 'skipped_exists';
      ELSE
        IF NOT p_dry_run THEN
          INSERT INTO slots (date, start_time, end_time, course_id, capacity, generated_from_rule, status, note)
          VALUES (d, extra_ex.start_time, computed_end, extra_ex.course_id,
                  COALESCE(extra_ex.ex_capacity, extra_ex.default_capacity),
                  false, 'open', extra_ex.title);
          action := 'created';
        ELSE
          action := 'would_create';
        END IF;
      END IF;

      slot_date   := d;
      weekday     := weekday_ja;
      start_time  := extra_ex.start_time;
      end_time    := computed_end;
      course_code := extra_ex.code;
      course_name := COALESCE(extra_ex.title, extra_ex.name);
      capacity    := COALESCE(extra_ex.ex_capacity, extra_ex.default_capacity);
      reason      := '追加枠';
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

-- Only allow authenticated (staff) and service_role to invoke.
REVOKE ALL ON FUNCTION generate_slots_for_month(int, int, bool) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_slots_for_month(int, int, bool) TO authenticated, service_role;

-- Quick sanity check: what would August 2026 generate?
-- SELECT * FROM generate_slots_for_month(2026, 8, true) ORDER BY slot_date, start_time;
