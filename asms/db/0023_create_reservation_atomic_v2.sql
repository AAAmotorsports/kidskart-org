-- =========================================================================
-- 0023_create_reservation_atomic_v2.sql
-- -------------------------------------------------------------------------
-- create_reservation_atomic の残席カウントバグを修正。
--
-- 問題 (0012 版):
--   予約中の 3 名のうち 1 名が個別キャンセル (attendance_status='cancelled')
--   されると、その席は返っているはずなのに RPC 側の残席カウントに残っており、
--   新規予約が「満席」で弾かれるケースがあった。
--
-- 修正:
--   v_reserved_count の集計に AND rp.attendance_status <> 'cancelled' を追加。
--   これで顧客/管理どちらの経路で個別キャンセルされた席も、新規予約で再利用
--   可能になる。
--
-- CREATE OR REPLACE で関数本体だけ差し替え。他の呼び出し規約は不変。
-- =========================================================================

create or replace function create_reservation_atomic(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  in_slot_id        UUID     := (payload->>'slot_id')::UUID;
  in_term_id        UUID     := (payload->>'term_id')::UUID;
  in_price_tier     TEXT     := payload->>'price_tier';
  in_guardian       JSONB    := payload->'guardian';
  in_emergency      JSONB    := payload->'emergency';
  in_participants   JSONB    := payload->'participants';
  in_consent        JSONB    := payload->'consent';
  in_signature      JSONB    := payload->'signature';

  v_slot            slots%ROWTYPE;
  v_term            terms%ROWTYPE;
  v_price_per       INT;
  v_total_amount    INT;
  v_reserved_count  INT;
  v_add_count       INT      := jsonb_array_length(in_participants);
  v_guardian_id     UUID;
  v_customer_id     UUID;
  v_reservation_id  UUID;
  v_participant_id  UUID;
  v_reservation_no  TEXT;
  v_status          TEXT;
  v_cancel_token    TEXT;
  v_participant     JSONB;
  v_i               INT;
  v_course_name     TEXT;
begin
  -- ---- Slot lock (FOR UPDATE): TOCTOU 対策 --------------------------------
  SELECT * INTO v_slot FROM slots WHERE id = in_slot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'スロットが見つかりません' USING ERRCODE = 'PGRSN', HINT = 'slot_not_found';
  END IF;
  IF v_slot.status <> 'open' THEN
    RAISE EXCEPTION 'このスロットは受付を停止しています' USING ERRCODE = 'PGRSN', HINT = 'slot_not_open';
  END IF;

  -- 個別キャンセルされた参加者は席を返しているので集計から除外
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

  -- ---- Terms snapshot --------------------------------------------------
  SELECT * INTO v_term FROM terms WHERE id = in_term_id;
  IF v_term IS NULL THEN
    RAISE EXCEPTION '利用規約バージョンが見つかりません' USING ERRCODE = 'PGRSN', HINT = 'terms_not_found';
  END IF;

  -- ---- Guardian dedup by email ----------------------------------------
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

  -- ---- Price / status --------------------------------------------------
  SELECT
    CASE WHEN in_price_tier = 'member' THEN c.price_member ELSE c.price_regular END,
    c.name,
    CASE WHEN c.requires_approval THEN 'pending_approval' ELSE 'confirmed' END
  INTO v_price_per, v_course_name, v_status
  FROM courses c WHERE c.id = v_slot.course_id;

  v_total_amount := v_price_per * v_add_count;

  -- ---- Reservation ----------------------------------------------------
  INSERT INTO reservations (
    slot_id, guardian_id, status, price_tier, total_amount, note
  ) VALUES (
    in_slot_id, v_guardian_id, v_status::reservation_status, in_price_tier::price_tier, v_total_amount, NULL
  )
  RETURNING id, reservation_number, cancel_token INTO v_reservation_id, v_reservation_no, v_cancel_token;

  -- ---- Consent snapshot ------------------------------------------------
  INSERT INTO consents (
    reservation_id, term_id, term_version,
    body_snapshot_md, body_snapshot_hash,
    checked_items, signature_type, signature_data
  ) VALUES (
    v_reservation_id, v_term.id, v_term.version,
    v_term.body_markdown, v_term.content_hash,
    in_consent->'checked_items',
    (in_signature->>'type')::signature_type,
    in_signature->>'data'
  );

  -- ---- Participants ----------------------------------------------------
  v_i := 0;
  FOR v_participant IN SELECT jsonb_array_elements(in_participants) LOOP
    v_i := v_i + 1;

    -- Customer dedup by guardian + name + kana + birth
    SELECT c.id INTO v_customer_id
      FROM customers c
      JOIN guardian_customer_links gcl ON gcl.customer_id = c.id
     WHERE gcl.guardian_id = v_guardian_id
       AND c.name = v_participant->>'name'
       AND c.kana = v_participant->>'kana'
       AND c.birth_date = (v_participant->>'birth_date')::DATE
       AND c.is_deleted = FALSE
     LIMIT 1;

    IF v_customer_id IS NULL THEN
      INSERT INTO customers (
        name, kana, birth_date, gender
      ) VALUES (
        v_participant->>'name',
        v_participant->>'kana',
        (v_participant->>'birth_date')::DATE,
        (v_participant->>'gender')::gender
      )
      RETURNING id INTO v_customer_id;

      INSERT INTO guardian_customer_links (guardian_id, customer_id, relation, is_primary)
      VALUES (v_guardian_id, v_customer_id, 'parent', TRUE);
    END IF;

    INSERT INTO reservation_participants (
      reservation_id, customer_id, participant_index,
      name_snapshot, kana_snapshot, birth_date_snapshot, gender_snapshot,
      age_at_booking, height_cm, photo_consent, kart_experience_note
    ) VALUES (
      v_reservation_id, v_customer_id, v_i,
      v_participant->>'name',
      v_participant->>'kana',
      (v_participant->>'birth_date')::DATE,
      (v_participant->>'gender')::gender,
      (v_participant->>'age_at_booking')::INT,
      (v_participant->>'height_cm')::INT,
      (v_participant->>'photo_consent')::photo_consent,
      NULLIF(v_participant->>'kart_experience_note', '')
    )
    RETURNING id INTO v_participant_id;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', v_reservation_id,
    'reservation_number', v_reservation_no,
    'cancel_token', v_cancel_token,
    'status', v_status,
    'total_amount', v_total_amount,
    'course_name', v_course_name,
    'slot_date', v_slot.date,
    'slot_start_time', v_slot.start_time,
    'slot_end_time', v_slot.end_time
  );
end;
$$;

-- Re-grant just in case
revoke all on function create_reservation_atomic(jsonb) from public, anon, authenticated;
grant execute on function create_reservation_atomic(jsonb) to service_role;
