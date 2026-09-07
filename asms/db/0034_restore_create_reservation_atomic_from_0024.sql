-- =========================================================================
-- 0034_restore_create_reservation_atomic_from_0024.sql
-- -------------------------------------------------------------------------
-- 緊急ホットフィックス (2026-09-07 continued):
--
-- 0032_booking_cutoff_3h.sql は cutoff 機能を追加する際、`CREATE OR REPLACE
-- FUNCTION create_reservation_atomic(...)` の関数本体を「0024 と同じ
-- ロジック」と称して書き直したが、実際は存在しない関数や存在しない列を
-- 多数呼び出す別実装 (幻覚) に置き換えてしまった:
--
--   - gen_next_reservation_number() / gen_next_customer_number()
--     → 実 DB には無い (0024 は RETURNING で DB 生成の値を取得、
--        customer_number は inline で 'C-' || to_hex(...) || '-' || lpad(...))
--   - reservations の列名: unit_price / participant_count /
--     emergency_name / emergency_phone / emergency_relation
--     → 実 schema には無い (emergency は guardians 側に持つ)
--   - customers の列名: merged_into / height_cm_latest
--     → 実 schema には無い
--   - terms の列名: body_summary / weather_policy_md / cancel_policy_md
--     → 0024 が使うのは body_markdown / content_hash のみ
--   - guardian_customer_links に is_primary を渡していない (0024 は必須扱い)
--   - reservation_participants の列: seat_order / unit_price
--     → 実 schema には無い (0024 は attendance_status default で足りる)
--   - consents の列名: term_version_snapshot
--     → 実 schema は term_version (0024 の綴りが正しい)
--
-- 結果: 0033 で 1 引数版を DROP して overloading 曖昧性を解消したあと、
-- 全ての WEB / admin 新規予約リクエストで
--   ERROR:  function gen_next_reservation_number() does not exist
--   HINT:   No function matches the given name and argument types
-- が発生し、**顧客・管理者両方の新規予約が完全停止**した (2026-09-07)。
--
-- 対処:
--   1. 0032 が定義した 2 引数版を DROP
--   2. 0024 の body を **一字一句変更せずに** 復元し、そこに 0032 の
--      「cutoff 機能」だけを最小差分で追加した関数を CREATE
--
-- 0024 body に対する 0032 由来の追加点は次の 3 箇所のみ:
--   A) 関数シグネチャに p_bypass_cutoff BOOLEAN DEFAULT FALSE を追加
--   B) DECLARE に v_slot_start_ts / v_cutoff_ts の 2 変数追加
--   C) slot_not_open チェック直後に cutoff チェックブロックを 1 個挿入
-- 他は 0024 と完全一致。
--
-- 本 SQL は本番 Supabase SQL Editor で **今すぐ手動実行が必要**。
-- 実行前は全ての新規予約が失敗し続ける (現在の本番状態)。
-- =========================================================================

-- 1. 0032 が定義した壊れた 2 引数版を明示 DROP
DROP FUNCTION IF EXISTS create_reservation_atomic(JSONB, BOOLEAN);

-- 2. 0024 body を復元 + cutoff の 3 箇所差分だけ追加
CREATE OR REPLACE FUNCTION create_reservation_atomic(
  payload         JSONB,
  p_bypass_cutoff BOOLEAN DEFAULT FALSE  -- [A] 0032 由来: admin API のみ TRUE
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
  v_slot_start_ts   TIMESTAMPTZ;  -- [B] 0032 由来: cutoff 判定用
  v_cutoff_ts       TIMESTAMPTZ;  -- [B] 0032 由来: cutoff 判定用
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

  -- [C] 0032 由来: WEB 予約締切チェック (管理者 API 以外は必ずここを通す)
  -- p_bypass_cutoff = TRUE の場合は skip (admin proxy path 専用)
  IF NOT p_bypass_cutoff THEN
    IF v_slot.date IS NOT NULL AND v_slot.start_time IS NOT NULL THEN
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
    RAISE EXCEPTION '満席のため受付できません (残 % 名 / 追加 % 名)',
      GREATEST(0, v_slot.capacity - v_reserved_count), v_add_count
      USING ERRCODE = 'PGRSN', HINT = 'slot_full';
  END IF;

  SELECT id, version, body_markdown, content_hash INTO v_term
    FROM terms WHERE id = in_term_id;
  IF v_term IS NULL THEN
    RAISE EXCEPTION '利用規約バージョンが見つかりません' USING ERRCODE = 'PGRSN', HINT = 'terms_not_found';
  END IF;

  SELECT id INTO v_guardian_id
    FROM guardians
   WHERE lower(email) = lower(in_guardian->>'email')
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_guardian_id IS NOT NULL THEN
    UPDATE guardians SET
      name  = in_guardian->>'name',
      kana  = in_guardian->>'kana',
      phone = in_guardian->>'phone',
      postal_code = NULLIF(in_guardian->>'postal_code', ''),
      address     = NULLIF(in_guardian->>'address', ''),
      emergency_contact_name     = in_emergency->>'name',
      emergency_contact_phone    = in_emergency->>'phone',
      emergency_contact_relation = NULLIF(in_emergency->>'relation', '')
    WHERE id = v_guardian_id;
  ELSE
    INSERT INTO guardians (
      name, kana, phone, email, postal_code, address,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation
    ) VALUES (
      in_guardian->>'name',
      in_guardian->>'kana',
      in_guardian->>'phone',
      in_guardian->>'email',
      NULLIF(in_guardian->>'postal_code', ''),
      NULLIF(in_guardian->>'address', ''),
      in_emergency->>'name',
      in_emergency->>'phone',
      NULLIF(in_emergency->>'relation', '')
    )
    RETURNING id INTO v_guardian_id;
  END IF;

  v_per_price := CASE WHEN in_price_tier = 'member' THEN v_course.price_member
                                                    ELSE v_course.price_regular END;
  v_total   := v_per_price * v_add_count;
  v_status  := CASE WHEN v_course.requires_approval THEN 'pending_approval'::reservation_status
                                                     ELSE 'confirmed'::reservation_status END;

  INSERT INTO reservations (slot_id, guardian_id, status, price_tier, total_amount)
  VALUES (in_slot_id, v_guardian_id, v_status,
          CASE WHEN in_price_tier = 'member' THEN 'member'::price_tier ELSE 'regular'::price_tier END,
          v_total)
  RETURNING id, reservation_number, cancel_token
    INTO v_reservation_id, v_reservation_num, v_cancel_token;

  FOR v_i IN 0 .. v_add_count - 1 LOOP
    v_participant := in_participants->v_i;

    SELECT c.id INTO v_existing_cust
      FROM guardian_customer_links gcl
      JOIN customers c ON c.id = gcl.customer_id
     WHERE gcl.guardian_id = v_guardian_id
       AND c.is_deleted = false
       AND c.name = v_participant->>'name'
       AND c.kana = v_participant->>'kana'
       AND c.birth_date = (v_participant->>'birth_date')::DATE
     LIMIT 1;

    IF v_existing_cust IS NOT NULL THEN
      v_customer_id := v_existing_cust;
    ELSE
      v_customer_number := 'C-' ||
        upper(to_hex(extract(epoch from clock_timestamp())::bigint)) || '-' ||
        lpad(floor(random() * 100000)::TEXT, 5, '0');

      INSERT INTO customers (customer_number, name, kana, birth_date, gender)
      VALUES (
        v_customer_number,
        v_participant->>'name',
        v_participant->>'kana',
        (v_participant->>'birth_date')::DATE,
        (v_participant->>'gender')::gender
      )
      RETURNING id INTO v_customer_id;

      INSERT INTO guardian_customer_links (guardian_id, customer_id, relation, is_primary)
      VALUES (v_guardian_id, v_customer_id, COALESCE(in_emergency->>'relation', '保護者'), true);
    END IF;

    INSERT INTO reservation_participants (
      reservation_id, customer_id, name_snapshot, kana_snapshot,
      birth_date_snapshot, age_at_booking, height_cm, gender_snapshot,
      kart_experience_note, photo_consent
    ) VALUES (
      v_reservation_id, v_customer_id,
      v_participant->>'name',
      v_participant->>'kana',
      (v_participant->>'birth_date')::DATE,
      GREATEST(0, extract(year from age((v_participant->>'birth_date')::DATE))::INT),
      (v_participant->>'height_cm')::INT,
      (v_participant->>'gender')::gender,
      NULLIF(v_participant->>'kart_experience_note', ''),
      COALESCE((v_participant->>'photo_consent')::photo_consent, 'allow'::photo_consent)
    );
  END LOOP;

  BEGIN
    v_ip_inet := NULLIF(in_ip, '')::INET;
  EXCEPTION WHEN OTHERS THEN
    v_ip_inet := NULL;
  END;

  INSERT INTO consents (
    reservation_id, term_id, term_version, term_body_snapshot, term_hash_snapshot,
    consenter_name, signature_type, signature_typed_name, signature_image_key,
    ip_address, user_agent, checked_safety_items, declaration_text
  ) VALUES (
    v_reservation_id, v_term.id, v_term.version, v_term.body_markdown, v_term.content_hash,
    in_guardian->>'name',
    (in_signature->>'type')::signature_type,
    CASE WHEN in_signature->>'type' = 'typed' THEN in_signature->>'typed_name' ELSE NULL END,
    CASE WHEN in_signature->>'type' = 'drawn' THEN in_signature->>'image_data' ELSE NULL END,
    v_ip_inet,
    NULLIF(in_ua, ''),
    in_safety_items,
    '本規約およびキャンセルポリシー、安全ルール全10項目に同意します。'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', v_reservation_id,
    'reservation_number', v_reservation_num,
    'cancel_token', v_cancel_token,
    'status', v_status::TEXT,
    'total_amount', v_total,
    'course_name', v_course.name,
    'slot_date', v_slot.date,
    'slot_start_time', v_slot.start_time,
    'slot_end_time', v_slot.end_time
  );
END;
$$;

REVOKE ALL ON FUNCTION create_reservation_atomic(JSONB, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_reservation_atomic(JSONB, BOOLEAN) TO service_role;

COMMENT ON FUNCTION create_reservation_atomic(JSONB, BOOLEAN) IS
  'WEB 予約 (customer) / 管理者代理予約 (staff) 共通 RPC。'
  'p_bypass_cutoff=TRUE は管理者 API 経由のみ (endpoint 側で hard-coded)。'
  '本体は 0024 (正常動作していた実装) を復元し、cutoff 判定だけを追加した版。';
