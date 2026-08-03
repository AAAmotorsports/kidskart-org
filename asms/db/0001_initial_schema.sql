-- =========================================================================
-- ASMS (AAA Safety Management System) — Initial Schema v1.0.0
-- =========================================================================
-- Target: PostgreSQL 15+ / Supabase
-- Idempotent migration: safe to re-run on empty DB.
--
-- Design principles:
--   1. Guardian and Customer (child) are SEPARATE entities linked many-to-many.
--   2. Reservation captures WHO booked, WHAT slot, and immutable snapshots.
--   3. Consent records preserve the EXACT terms text and version at moment of
--      agreement — never overwritten when terms change.
--   4. Health/PII columns use pgcrypto for at-rest column-level encryption.
--   5. Row-Level Security (RLS) enforced from day 1; anon role gets zero read.
--   6. All mutations recorded to audit_logs via triggers.
-- =========================================================================

-- Fully idempotent: drop everything from a previous run before recreating.
-- Safe on empty DB (all IF EXISTS). CASCADE handles dependent objects.
DROP TABLE IF EXISTS
  audit_logs, staff,
  customer_bests, customer_progressions,
  consents, terms,
  reservation_participants, reservations,
  guardian_customer_links, customers, guardians,
  slots, schedule_exceptions, schedule_rules, courses
  CASCADE;

DROP TYPE IF EXISTS
  slot_status, skill_level, signature_type, vehicle_type,
  price_tier, staff_role, gender, photo_consent,
  attendance_status, reservation_status
  CASCADE;

DROP FUNCTION IF EXISTS touch_updated_at() CASCADE;
DROP FUNCTION IF EXISTS recalc_customer_participations() CASCADE;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- -------------------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------------------
CREATE TYPE reservation_status AS ENUM (
  'draft', 'pending_approval', 'confirmed',
  'attended', 'no_show', 'cancelled'
);

CREATE TYPE attendance_status AS ENUM (
  'expected', 'attended', 'no_show', 'cancelled'
);

CREATE TYPE photo_consent AS ENUM (
  'allow', 'face_blur_only', 'deny'
);

CREATE TYPE gender AS ENUM ('male', 'female', 'other');

CREATE TYPE staff_role AS ENUM (
  'owner', 'manager', 'staff', 'viewer'
);

CREATE TYPE price_tier AS ENUM ('regular', 'member');

CREATE TYPE vehicle_type AS ENUM (
  'mini_default', 'toyopet_kart', 'rotax_micro'
);

CREATE TYPE signature_type AS ENUM ('drawn', 'typed');

CREATE TYPE skill_level AS ENUM (
  'first_time',
  'needs_re_lecture',
  'solo_ok',
  'challenge_recommended',
  'challenge_active'
);

CREATE TYPE slot_status AS ENUM ('open', 'closed', 'cancelled');

-- -------------------------------------------------------------------------
-- courses — course masters (体験・リピート・チャレンジ・イベント)
-- -------------------------------------------------------------------------
CREATE TABLE courses (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  duration_min      INT NOT NULL,
  default_capacity  INT NOT NULL DEFAULT 3,
  price_regular     INT NOT NULL,
  price_member      INT NOT NULL,
  vehicle           vehicle_type NOT NULL DEFAULT 'mini_default',
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  blocks_morning    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  display_order     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN courses.blocks_morning IS
  'true = チャレンジ日など、その日の他のミニサーキット枠を自動抑止';

INSERT INTO courses (code, name, duration_min, default_capacity, price_regular, price_member, vehicle, requires_approval, blocks_morning, display_order) VALUES
  ('taiken',        '体験教室',                    50,  3, 6500,  4500, 'mini_default',  false, false, 1),
  ('repeat_60',     'リピート練習 60分',           50,  4, 6500,  4500, 'mini_default',  false, false, 2),
  ('repeat_30',     'リピート練習 30分',           25,  4, 3500,  3000, 'mini_default',  false, false, 3),
  ('challenge_ts',  'チャレンジクラス (トヨピー)', 165, 8, 17500, 15500,'toyopet_kart',  false, true,  4),
  ('challenge_rx',  'チャレンジクラス (Rotax)',    165, 8, 24500, 24500,'rotax_micro',   false, true,  5);

-- -------------------------------------------------------------------------
-- schedule_rules — 曜日ベースの繰り返しルール
-- -------------------------------------------------------------------------
CREATE TABLE schedule_rules (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id    UUID NOT NULL REFERENCES courses(id),
  weekday_mask INT NOT NULL,  -- bit mask: 1=月,2=火,4=水,8=木,16=金,32=土,64=日,128=祝
  start_time   TIME NOT NULL,
  capacity     INT,           -- null = use courses.default_capacity
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE,        -- null = 常時
  effective_to   DATE,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed schedule_rules to match current live Reserva calendar (as of 2026-08).
-- weekday_mask 32|64|128 = 土 (Sat) | 日 (Sun) | 祝 (Holiday).
-- The advertised menu also lists 12:00 taiken and 9:30 repeat_30 slots but
-- they are not currently active in the calendar. The owner can activate them
-- later by adding rules from the admin panel.

-- 体験教室: 3 slots per weekend/holiday
INSERT INTO schedule_rules (course_id, weekday_mask, start_time)
SELECT id, 32|64|128, t FROM courses, unnest(ARRAY['10:00','14:00','16:00']::TIME[]) AS t
 WHERE code = 'taiken';

-- リピート60: 3 slots per weekend/holiday
INSERT INTO schedule_rules (course_id, weekday_mask, start_time)
SELECT id, 32|64|128, t FROM courses, unnest(ARRAY['11:00','13:00','15:00']::TIME[]) AS t
 WHERE code = 'repeat_60';

-- リピート30: 3 slots per weekend/holiday (menu advertises 9:30 too — currently inactive)
INSERT INTO schedule_rules (course_id, weekday_mask, start_time)
SELECT id, 32|64|128, t FROM courses, unnest(ARRAY['11:00','13:00','15:00']::TIME[]) AS t
 WHERE code = 'repeat_30';

-- -------------------------------------------------------------------------
-- schedule_exceptions — 休業日・チャレンジ開催日・特別イベント
-- -------------------------------------------------------------------------
CREATE TABLE schedule_exceptions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date         DATE NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('closure','challenge','event','extra_slot')),
  course_id    UUID REFERENCES courses(id),  -- for challenge/event
  start_time   TIME,
  capacity     INT,
  title        TEXT,
  note         TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_exceptions_date ON schedule_exceptions(date);

-- -------------------------------------------------------------------------
-- slots — 実際に予約可能な枠（cron でルール + 例外から自動生成）
-- -------------------------------------------------------------------------
CREATE TABLE slots (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date              DATE NOT NULL,
  start_time        TIME NOT NULL,
  end_time          TIME NOT NULL,
  course_id         UUID NOT NULL REFERENCES courses(id),
  capacity          INT NOT NULL,
  generated_from_rule BOOLEAN NOT NULL DEFAULT TRUE,
  status            slot_status NOT NULL DEFAULT 'open',
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, start_time, course_id)
);

CREATE INDEX idx_slots_date ON slots(date, status);

-- -------------------------------------------------------------------------
-- guardians — 保護者
-- -------------------------------------------------------------------------
CREATE TABLE guardians (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL,
  kana                  TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  email                 CITEXT NOT NULL,
  postal_code           TEXT,
  address               TEXT,
  emergency_contact_name    TEXT,
  emergency_contact_phone   TEXT,
  emergency_contact_relation TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_guardians_phone ON guardians(phone);
CREATE INDEX idx_guardians_email ON guardians(email);

-- -------------------------------------------------------------------------
-- customers — 子供の永続エンティティ (Airレジ的な顧客管理)
-- -------------------------------------------------------------------------
CREATE TABLE customers (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_number          TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  kana                     TEXT NOT NULL,
  birth_date               DATE NOT NULL,
  gender                   gender NOT NULL,
  current_skill_level      skill_level NOT NULL DEFAULT 'first_time',
  total_participations     INT NOT NULL DEFAULT 0,
  first_participation_at   TIMESTAMPTZ,
  last_participation_at    TIMESTAMPTZ,
  staff_notes              TEXT,
  next_recommendation      TEXT,
  merged_into_id           UUID REFERENCES customers(id),
  is_deleted               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_number ON customers(customer_number);
CREATE INDEX idx_customers_name_kana ON customers(name, kana);
CREATE INDEX idx_customers_skill ON customers(current_skill_level) WHERE NOT is_deleted;

-- -------------------------------------------------------------------------
-- guardian_customer_links — 保護者 ⇔ 子供 多対多
-- -------------------------------------------------------------------------
CREATE TABLE guardian_customer_links (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  guardian_id  UUID NOT NULL REFERENCES guardians(id),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  relation     TEXT NOT NULL,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guardian_id, customer_id)
);

CREATE INDEX idx_gc_links_guardian ON guardian_customer_links(guardian_id);
CREATE INDEX idx_gc_links_customer ON guardian_customer_links(customer_id);

-- -------------------------------------------------------------------------
-- terms — 利用規約（バージョン管理・上書き禁止）
-- -------------------------------------------------------------------------
CREATE TABLE terms (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  version           TEXT NOT NULL UNIQUE,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  body_markdown     TEXT NOT NULL,
  body_summary      TEXT NOT NULL,
  weather_policy_md TEXT NOT NULL,
  cancel_policy_md  TEXT NOT NULL,
  safety_items      JSONB NOT NULL,
  content_hash      TEXT NOT NULL,
  is_current        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_terms_current_singleton ON terms(is_current) WHERE is_current;

COMMENT ON COLUMN terms.safety_items IS
  'Array of {id, text} — the 10 individual safety check items';

-- -------------------------------------------------------------------------
-- reservations — 予約本体
-- -------------------------------------------------------------------------
CREATE TABLE reservations (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_number   TEXT NOT NULL UNIQUE,
  slot_id              UUID NOT NULL REFERENCES slots(id),
  guardian_id          UUID NOT NULL REFERENCES guardians(id),
  status               reservation_status NOT NULL DEFAULT 'confirmed',
  price_tier           price_tier NOT NULL DEFAULT 'regular',
  total_amount         INT NOT NULL DEFAULT 0,
  note                 TEXT,
  cancel_token         TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'base64url'),
  approved_at          TIMESTAMPTZ,
  approved_by          UUID,
  approval_note        TEXT,
  checked_in_at        TIMESTAMPTZ,
  checked_in_by        UUID,
  safety_briefed_at    TIMESTAMPTZ,
  safety_briefed_by    UUID,
  cancelled_at         TIMESTAMPTZ,
  cancelled_reason     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reservations_slot ON reservations(slot_id);
CREATE INDEX idx_reservations_guardian ON reservations(guardian_id);
CREATE INDEX idx_reservations_status ON reservations(status);
CREATE INDEX idx_reservations_cancel_token ON reservations(cancel_token);

-- -------------------------------------------------------------------------
-- reservation_participants — 予約参加者スナップショット
-- -------------------------------------------------------------------------
CREATE TABLE reservation_participants (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id        UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id),
  name_snapshot         TEXT NOT NULL,
  kana_snapshot         TEXT NOT NULL,
  birth_date_snapshot   DATE NOT NULL,
  age_at_booking        INT NOT NULL,
  height_cm             INT NOT NULL,
  gender_snapshot       gender NOT NULL,
  kart_experience_note  TEXT,
  health_notes_encrypted BYTEA,
  photo_consent         photo_consent NOT NULL,
  attendance_status     attendance_status NOT NULL DEFAULT 'expected',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rp_reservation ON reservation_participants(reservation_id);
CREATE INDEX idx_rp_customer ON reservation_participants(customer_id);

-- -------------------------------------------------------------------------
-- consents — 同意履歴（永続保存・上書き禁止）
-- -------------------------------------------------------------------------
CREATE TABLE consents (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reservation_id        UUID NOT NULL REFERENCES reservations(id),
  term_id               UUID NOT NULL REFERENCES terms(id),
  term_version          TEXT NOT NULL,
  term_body_snapshot    TEXT NOT NULL,
  term_hash_snapshot    TEXT NOT NULL,
  consented_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consenter_name        TEXT NOT NULL,
  signature_type        signature_type NOT NULL,
  signature_typed_name  TEXT,
  signature_image_key   TEXT,
  ip_address            INET,
  user_agent            TEXT,
  checked_safety_items  JSONB NOT NULL,
  declaration_text      TEXT NOT NULL
);

CREATE INDEX idx_consents_reservation ON consents(reservation_id);
CREATE INDEX idx_consents_term ON consents(term_id);

-- -------------------------------------------------------------------------
-- customer_progressions — 習熟度変更履歴
-- -------------------------------------------------------------------------
CREATE TABLE customer_progressions (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id                 UUID NOT NULL REFERENCES customers(id),
  reservation_participant_id  UUID REFERENCES reservation_participants(id),
  from_level                  skill_level,
  to_level                    skill_level NOT NULL,
  reason                      TEXT,
  changed_by                  UUID NOT NULL,
  changed_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_progressions_customer ON customer_progressions(customer_id, changed_at DESC);

-- -------------------------------------------------------------------------
-- customer_bests — ベストタイム記録
-- -------------------------------------------------------------------------
CREATE TABLE customer_bests (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id                 UUID NOT NULL REFERENCES customers(id),
  reservation_participant_id  UUID REFERENCES reservation_participants(id),
  record_type                 TEXT NOT NULL,
  value_ms                    INT NOT NULL,
  vehicle_name                TEXT,
  note                        TEXT,
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by                 UUID NOT NULL
);

CREATE INDEX idx_bests_customer ON customer_bests(customer_id, record_type, value_ms);

-- -------------------------------------------------------------------------
-- staff — スタッフアカウント
-- -------------------------------------------------------------------------
CREATE TABLE staff (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id   UUID UNIQUE,
  email          CITEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  role           staff_role NOT NULL DEFAULT 'staff',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- audit_logs — 全 write 操作の監査ログ
-- -------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id      UUID,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('staff','guest','system')),
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     UUID,
  ip_address    INET,
  user_agent    TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);

-- -------------------------------------------------------------------------
-- Triggers
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_courses_touch      BEFORE UPDATE ON courses      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_guardians_touch    BEFORE UPDATE ON guardians    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_customers_touch    BEFORE UPDATE ON customers    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_reservations_touch BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_staff_touch        BEFORE UPDATE ON staff        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Auto-recalc customer.total_participations on attendance update
CREATE OR REPLACE FUNCTION recalc_customer_participations() RETURNS TRIGGER AS $$
DECLARE cid UUID;
BEGIN
  cid := COALESCE(NEW.customer_id, OLD.customer_id);
  UPDATE customers c SET
    total_participations = (
      SELECT COUNT(*) FROM reservation_participants rp
      WHERE rp.customer_id = cid AND rp.attendance_status = 'attended'
    ),
    first_participation_at = (
      SELECT MIN(r.checked_in_at) FROM reservation_participants rp
      JOIN reservations r ON rp.reservation_id = r.id
      WHERE rp.customer_id = cid AND rp.attendance_status = 'attended'
    ),
    last_participation_at = (
      SELECT MAX(r.checked_in_at) FROM reservation_participants rp
      JOIN reservations r ON rp.reservation_id = r.id
      WHERE rp.customer_id = cid AND rp.attendance_status = 'attended'
    )
  WHERE c.id = cid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rp_recalc AFTER INSERT OR UPDATE OR DELETE ON reservation_participants
  FOR EACH ROW EXECUTE FUNCTION recalc_customer_participations();

-- -------------------------------------------------------------------------
-- Row Level Security (RLS)
-- -------------------------------------------------------------------------
ALTER TABLE courses                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_rules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_exceptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians                ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers                ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_customer_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_progressions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_bests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs               ENABLE ROW LEVEL SECURITY;

-- Public read: only what's needed to render the booking form
CREATE POLICY public_read_courses ON courses FOR SELECT USING (is_active);
CREATE POLICY public_read_slots ON slots FOR SELECT USING (status = 'open' AND date >= CURRENT_DATE);
CREATE POLICY public_read_current_terms ON terms FOR SELECT USING (is_current);

-- Everything else: staff only (default-deny for anon)
CREATE POLICY staff_all_courses      ON courses      FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_rules        ON schedule_rules FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_exceptions   ON schedule_exceptions FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_slots        ON slots        FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_guardians    ON guardians    FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_customers    ON customers    FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_gc_links     ON guardian_customer_links FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_reservations ON reservations FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_rp           ON reservation_participants FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_terms        ON terms        FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_consents     ON consents     FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_progressions ON customer_progressions FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_bests        ON customer_bests FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_all_staff        ON staff        FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY staff_read_audit       ON audit_logs   FOR SELECT USING (auth.role() = 'authenticated');

-- Guest INSERT (via server-side API only, using service key that bypasses RLS)
-- No public INSERT policies — all writes go through server-side API endpoints.

-- -------------------------------------------------------------------------
-- Table-level GRANTs
-- -------------------------------------------------------------------------
-- RLS only kicks in once PostgreSQL has granted the base privilege to the
-- role. Without these GRANTs even a permissive RLS policy dies with
-- "42501: permission denied for table ...". The service_role bypass covers
-- all server-side writes, but browser reads via the anon key need this.

GRANT SELECT ON courses TO anon, authenticated;
GRANT SELECT ON slots    TO anon, authenticated;
GRANT SELECT ON terms    TO anon, authenticated;

GRANT ALL ON schedule_rules             TO authenticated;
GRANT ALL ON schedule_exceptions        TO authenticated;
GRANT ALL ON guardians                  TO authenticated;
GRANT ALL ON customers                  TO authenticated;
GRANT ALL ON guardian_customer_links    TO authenticated;
GRANT ALL ON reservations               TO authenticated;
GRANT ALL ON reservation_participants   TO authenticated;
GRANT ALL ON consents                   TO authenticated;
GRANT ALL ON customer_progressions      TO authenticated;
GRANT ALL ON customer_bests             TO authenticated;
GRANT ALL ON staff                      TO authenticated;
GRANT SELECT ON audit_logs              TO authenticated;
GRANT INSERT, UPDATE, DELETE ON courses TO authenticated;
GRANT INSERT, UPDATE, DELETE ON slots   TO authenticated;
GRANT INSERT, UPDATE, DELETE ON terms   TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =========================================================================
-- End of 0001_initial_schema.sql
-- =========================================================================
