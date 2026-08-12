-- =========================================================================
-- 0024_fix_reservation_atomic_columns.sql
-- -------------------------------------------------------------------------
-- 緊急修正: 0023 で create_reservation_atomic を書き直した際に、
-- consents テーブルの列名を誤った (body_snapshot_md / body_snapshot_hash
-- / checked_items 等) ため、予約確定時に
--   ERROR: column "body_snapshot_md" of relation "consents" does not exist
-- が発生するようになった。
--
-- 対処: 0012 の正しい列名 (term_body_snapshot / term_hash_snapshot /
-- checked_safety_items / consenter_name / signature_typed_name /
-- signature_image_key / declaration_text) に戻す。同時に 0023 で入れた
-- 残席バグ修正 (rp.attendance_status <> 'cancelled') は維持する。
-- =========================================================================

CREATE OR REPLACE FUNCTION create_reservation_atomic(payload JSONB)
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

REVOKE ALL ON FUNCTION create_reservation_atomic(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_reservation_atomic(JSONB) TO service_role;
