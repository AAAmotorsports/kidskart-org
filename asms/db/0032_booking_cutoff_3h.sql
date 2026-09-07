-- =========================================================================
-- 0032_booking_cutoff_3h.sql
-- -------------------------------------------------------------------------
-- WEB 予約締切: 開始 3 時間前まで
--
-- 目的:
--   一般 WEB 予約は開始 3 時間前で締切とする (現場準備・参加者確認の時間確保)。
--   例: 16:00 開始 → 13:00 で締切、13:00:01 以降の予約は拒否。
--
-- 対応レイヤ:
--   1. /reserve/ 一覧: cutoff 過ぎたスロットに「受付終了」表示 (UI 層)
--   2. /reserve/[slotId]: cutoff 過ぎたら wizard 非表示 + 案内 (UI 層)
--   3. /api/reserve/create: RPC 呼び出し時に p_bypass_cutoff を渡さない (API 層)
--   4. RPC create_reservation_atomic: p_bypass_cutoff = FALSE なら
--      cutoff チェック → 過ぎていれば slot_cutoff_passed エラー (DB 層・最終防衛)
--
-- 管理画面からのスタッフ代理予約 (/api/admin/reservations/create) は
-- p_bypass_cutoff = TRUE を明示的に渡して締切を bypass する。
-- 一般 API (/api/reserve/create) は p_bypass_cutoff を一切送らないので、
-- 悪意あるクライアントが payload に bypass フラグを混ぜても RPC に到達
-- しない (endpoint 側で hard-coded)。
--
-- 判定基準:
--   slot の date + start_time を Asia/Tokyo タイムゾーンで解釈した
--   絶対時刻 (v_slot_start_ts) が now() + 3h より小さければ (=既に 3h 以内
--   なら) 締切扱い。
--
-- start_time が NULL のスロットは cutoff 判定できないので、スキップして
-- 予約可能扱いにする (schema 上 slots.start_time は NOT NULL 制約ありなので
-- 通常起き得ないが、防御的措置)。
-- =========================================================================

CREATE OR REPLACE FUNCTION create_reservation_atomic(
  payload         JSONB,
  p_bypass_cutoff BOOLEAN DEFAULT FALSE  -- 新パラメータ (admin API からのみ TRUE)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
#variable_conflict use_column
DECLARE
  in_slot_id        UUID     := (payload->>'slot_id')::UUID;
  in_term_id        UUID     := (payload->>'term_id')::UUID;
  in_price_tier     TEXT     := payload->>'price_tier';
  in_guardian       JSONB    := payload->'guardian';
  in_emergency      JSONB    := payload->'emergency';
  in_participants   JSONB    := payload->'participants';
  in_signature      JSONB    := payload->'signature';
  in_safety_items   JSONB    := payload->'checked_safety_items';
  in_ip             TEXT     := payload->>'ip_address';
  in_ua             TEXT     := payload->>'user_agent';

  v_slot            RECORD;
  v_slot_start_ts   TIMESTAMPTZ;
  v_cutoff_ts       TIMESTAMPTZ;
  v_course          RECORD;
  v_reserved_count  INT;
  v_add_count       INT      := jsonb_array_length(in_participants);
  v_guardian_id     UUID;
  v_customer_id     UUID;
  v_reservation_id  UUID;
  v_reservation_num TEXT;
  v_cancel_token    TEXT;
  v_term            RECORD;
  v_participant     JSONB;
  v_per_price       INT;
  v_total           INT;
  v_status          reservation_status;
  v_customer_number TEXT;
  v_existing_cust   UUID;
  v_i               INT;
  v_ip_inet         INET;
BEGIN
  IF in_slot_id IS NULL OR in_term_id IS NULL THEN
    RAISE EXCEPTION 'slot_id と term_id は必須' USING ERRCODE = 'PGRSN', HINT = 'missing_field';
  END IF;
  IF v_add_count = 0 THEN
    RAISE EXCEPTION '参加者情報が空です' USING ERRCODE = 'PGRSN', HINT = 'empty_participants';
  END IF;

  SELECT s.id, s.date, s.start_time, s.end_time, s.capacity, s.status, s.course_id
    INTO v_slot
    FROM slots s
   WHERE s.id = in_slot_id
   FOR UPDATE;

  IF v_slot IS NULL THEN
    RAISE EXCEPTION 'スロットが見つかりません' USING ERRCODE = 'PGRSN', HINT = 'slot_not_found';
  END IF;
  IF v_slot.status <> 'open' THEN
    RAISE EXCEPTION 'このスロットは受付停止中です (%)', v_slot.status
      USING ERRCODE = 'PGRSN', HINT = 'slot_not_open';
  END IF;

  -- WEB 予約締切チェック (管理者 API 以外は必ずここを通す)
  -- p_bypass_cutoff = TRUE の場合は skip (admin proxy path 専用)
  IF NOT p_bypass_cutoff THEN
    IF v_slot.date IS NOT NULL AND v_slot.start_time IS NOT NULL THEN
      -- slot の date + start_time を Asia/Tokyo として絶対時刻化
      v_slot_start_ts := (v_slot.date + v_slot.start_time) AT TIME ZONE 'Asia/Tokyo';
      v_cutoff_ts     := v_slot_start_ts - INTERVAL '3 hours';
      IF now() >= v_cutoff_ts THEN
        RAISE EXCEPTION 'このスロットの WEB 予約は締切りました (開始 3 時間前まで)'
          USING ERRCODE = 'PGRSN', HINT = 'slot_cutoff_passed';
      END IF;
    END IF;
    -- date or start_time が NULL のスロットは cutoff 判定できないので通過
  END IF;

  SELECT c.id, c.name, c.price_regular, c.price_member, c.requires_approval
    INTO v_course
    FROM courses c
   WHERE c.id = v_slot.course_id;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'コース情報が取得できません' USING ERRCODE = 'PGRSN', HINT = 'course_not_found';
  END IF;

  -- 個別キャンセル (attendance_status='cancelled') した席は返っているので除外
  SELECT COUNT(*)::INT INTO v_reserved_count
    FROM reservation_participants rp
    JOIN reservations r ON r.id = rp.reservation_id
   WHERE r.slot_id = in_slot_id
     AND r.status <> 'cancelled'
     AND rp.attendance_status <> 'cancelled';

  IF v_reserved_count + v_add_count > v_slot.capacity THEN
    RAISE EXCEPTION '定員を超過します (残 % / 追加 %)',
      v_slot.capacity - v_reserved_count, v_add_count
      USING ERRCODE = 'PGRSN', HINT = 'slot_full';
  END IF;

  -- 以下、0024 と同じロジックのため省略。CREATE OR REPLACE FUNCTION で
  -- 関数本体を完全に置き換えるため、既存の 0024 の残りブロックをそのまま
  -- 継承する形で書き直す必要がある。
  -- ↓ ここに 0024 の残り (terms 取得 〜 最終 RETURN jsonb_build_object) を
  --    そのままコピー貼付する形で完成させる。
  SELECT t.id, t.version, t.body_markdown, t.body_summary,
         t.weather_policy_md, t.cancel_policy_md
    INTO v_term
    FROM terms t
   WHERE t.id = in_term_id;
  IF v_term IS NULL THEN
    RAISE EXCEPTION '利用規約が見つかりません' USING ERRCODE = 'PGRSN', HINT = 'terms_not_found';
  END IF;

  IF in_guardian IS NULL
     OR (in_guardian->>'email') IS NULL OR (in_guardian->>'email') = ''
     OR (in_guardian->>'name')  IS NULL OR (in_guardian->>'name')  = ''
     OR (in_guardian->>'phone') IS NULL OR (in_guardian->>'phone') = '' THEN
    RAISE EXCEPTION '保護者情報が不足しています' USING ERRCODE = 'PGRSN', HINT = 'missing_field';
  END IF;

  SELECT g.id INTO v_guardian_id
    FROM guardians g
   WHERE lower(g.email) = lower(in_guardian->>'email')
   LIMIT 1;

  IF v_guardian_id IS NULL THEN
    INSERT INTO guardians (
      name, kana, phone, email, postal_code, address, created_at, updated_at
    ) VALUES (
      in_guardian->>'name',
      in_guardian->>'kana',
      in_guardian->>'phone',
      lower(in_guardian->>'email'),
      in_guardian->>'postal_code',
      in_guardian->>'address',
      now(), now()
    )
    RETURNING id INTO v_guardian_id;
  ELSE
    UPDATE guardians
       SET name        = COALESCE(NULLIF(in_guardian->>'name', ''),  name),
           kana        = COALESCE(NULLIF(in_guardian->>'kana', ''),  kana),
           phone       = COALESCE(NULLIF(in_guardian->>'phone', ''), phone),
           postal_code = COALESCE(NULLIF(in_guardian->>'postal_code', ''), postal_code),
           address     = COALESCE(NULLIF(in_guardian->>'address', ''), address),
           updated_at  = now()
     WHERE id = v_guardian_id;
  END IF;

  v_per_price := CASE WHEN in_price_tier = 'member' THEN v_course.price_member
                                                    ELSE v_course.price_regular END;
  v_total     := v_per_price * v_add_count;
  v_status    := CASE WHEN v_course.requires_approval THEN 'pending_approval'
                                                      ELSE 'confirmed' END::reservation_status;

  v_cancel_token := encode(gen_random_bytes(32), 'hex');

  SELECT gen_next_reservation_number() INTO v_reservation_num;

  BEGIN
    v_ip_inet := in_ip::INET;
  EXCEPTION WHEN OTHERS THEN
    v_ip_inet := NULL;
  END;

  INSERT INTO reservations (
    reservation_number, slot_id, guardian_id, status,
    price_tier, unit_price, total_amount, participant_count,
    cancel_token, ip_address, user_agent, created_at, updated_at,
    emergency_name, emergency_phone, emergency_relation
  ) VALUES (
    v_reservation_num, in_slot_id, v_guardian_id, v_status,
    in_price_tier, v_per_price, v_total, v_add_count,
    v_cancel_token, v_ip_inet, in_ua, now(), now(),
    in_emergency->>'name', in_emergency->>'phone', in_emergency->>'relation'
  ) RETURNING id INTO v_reservation_id;

  v_i := 0;
  FOR v_participant IN SELECT * FROM jsonb_array_elements(in_participants) LOOP
    v_customer_id := NULL;
    IF v_participant ? 'kana' AND v_participant ? 'birth_date' THEN
      SELECT c.id INTO v_existing_cust
        FROM customers c
       WHERE c.kana = v_participant->>'kana'
         AND c.birth_date = (v_participant->>'birth_date')::DATE
         AND c.merged_into IS NULL
       LIMIT 1;
      IF v_existing_cust IS NOT NULL THEN
        v_customer_id := v_existing_cust;
      END IF;
    END IF;

    IF v_customer_id IS NULL THEN
      SELECT gen_next_customer_number() INTO v_customer_number;
      INSERT INTO customers (
        customer_number, name, kana, birth_date, gender,
        height_cm_latest, kart_experience_note, created_at, updated_at
      ) VALUES (
        v_customer_number,
        v_participant->>'name',
        v_participant->>'kana',
        (v_participant->>'birth_date')::DATE,
        v_participant->>'gender',
        (v_participant->>'height_cm')::INT,
        v_participant->>'kart_experience_note',
        now(), now()
      ) RETURNING id INTO v_customer_id;

      INSERT INTO guardian_customer_links (guardian_id, customer_id, relation, created_at)
      VALUES (v_guardian_id, v_customer_id, 'guardian', now())
      ON CONFLICT DO NOTHING;
    ELSE
      UPDATE customers
         SET height_cm_latest = (v_participant->>'height_cm')::INT,
             updated_at = now()
       WHERE id = v_customer_id;

      INSERT INTO guardian_customer_links (guardian_id, customer_id, relation, created_at)
      VALUES (v_guardian_id, v_customer_id, 'guardian', now())
      ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO reservation_participants (
      reservation_id, customer_id,
      name_snapshot, kana_snapshot, birth_date_snapshot, gender_snapshot,
      age_at_booking, height_cm, kart_experience_note,
      photo_consent, seat_order, unit_price, created_at, updated_at
    ) VALUES (
      v_reservation_id, v_customer_id,
      v_participant->>'name',
      v_participant->>'kana',
      (v_participant->>'birth_date')::DATE,
      v_participant->>'gender',
      EXTRACT(YEAR FROM AGE(v_slot.date, (v_participant->>'birth_date')::DATE))::INT,
      (v_participant->>'height_cm')::INT,
      v_participant->>'kart_experience_note',
      COALESCE(v_participant->>'photo_consent', 'allow'),
      v_i,
      v_per_price,
      now(), now()
    );

    v_i := v_i + 1;
  END LOOP;

  INSERT INTO consents (
    reservation_id, term_id, term_version_snapshot, term_body_snapshot, term_hash_snapshot,
    checked_safety_items,
    consenter_name, signature_type,
    signature_typed_name, signature_image_key,
    declaration_text, ip_address, user_agent, created_at
  ) VALUES (
    v_reservation_id, in_term_id, v_term.version, v_term.body_markdown,
    encode(digest(v_term.body_markdown, 'sha256'), 'hex'),
    COALESCE(in_safety_items, '[]'::jsonb),
    in_guardian->>'name',
    in_signature->>'type',
    in_signature->>'typed_name',
    in_signature->>'image_data',
    '本予約は各種同意事項を確認・同意のうえ送信されました',
    v_ip_inet, in_ua, now()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', v_reservation_id,
    'reservation_number', v_reservation_num,
    'status', v_status,
    'total_amount', v_total,
    'cancel_token', v_cancel_token,
    'course_name', v_course.name,
    'slot_date', v_slot.date,
    'slot_start_time', v_slot.start_time,
    'slot_end_time', v_slot.end_time
  );
END;
$$;

COMMENT ON FUNCTION create_reservation_atomic(JSONB, BOOLEAN) IS
  'WEB 予約 (customer) / 管理者代理予約 (staff) の共通 RPC。'
  'p_bypass_cutoff=TRUE は管理者 API 経由のみ許可 (endpoint 側で hard-coded)。';
