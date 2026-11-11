-- =============================================================================
-- A-ONE 走行写真販売 — D1 (SQLite) 初期スキーマ
-- =============================================================================
-- Supabase 案 (db/archive-supabase) からの主な変更:
--   * 同じ写真を何人にでも販売できる (order_items に注文をまたぐ一意制約は無い)
--   * 購入者ごとに 注文 / ダウンロード権限 / 返金 を独立管理
--   * 同一注文の二重決済防止: orders.cart_hash の一意制約 + payments.stripe_payment_intent の
--     一意制約 + 条件付き UPDATE。同一注文への 2 回目の支払いは payments に記録して要確認
--   * ロジック (価格・決済確定・返金) は PL/pgSQL から TypeScript (src/lib/shop) へ。
--     D1 は 1 回の batch() が原子的。テストは tests/ で同じ SQL を SQLite で実行する
--   * RLS は無い (D1 は公開エンドポイントを持たず Worker からしか触れない)
-- 日時は ISO8601 UTC 文字列 ('2026-11-11T05:00:00.000Z')、日付は JST の 'YYYY-MM-DD'
-- D1 の制限: 1 クエリの bind は 100 個まで → 配列は json_each(?) で渡す
-- =============================================================================

CREATE TABLE staff_users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- メールで届くログインリンク (パスワードを持たない。PBKDF2 は無料枠の CPU 10ms に収まらないため)
CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,                   -- SHA-256(token)
  staff_id    TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,                   -- SHA-256(Cookie の値)
  staff_id    TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT REFERENCES staff_users(id)
);
INSERT INTO settings(key, value) VALUES
  ('prices',    '{"single":500,"set3":1000,"pack":2000}'),
  ('retention', '{"view_days":30,"purchased_days":30,"purchased_max_days":60,"order_years":7}'),
  ('tv',        '{"slide_seconds":6,"group_seconds":60}');

CREATE TABLE groups (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  qr_token      TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),   -- 128bit
  shoot_date    TEXT NOT NULL,                                               -- JST 'YYYY-MM-DD'
  start_time    TEXT,
  name          TEXT,
  headcount     INTEGER CHECK (headcount IS NULL OR headcount BETWEEN 1 AND 500),
  plan          TEXT NOT NULL DEFAULT 'rental' CHECK (plan IN ('rental','race_pack','other')),

  -- 同意 (受付時に案内して取得)。撮影 / 販売ページ / 店内TV は別管理
  consent_shoot     INTEGER NOT NULL DEFAULT 0,
  consent_online    INTEGER NOT NULL DEFAULT 0,
  consent_tv        INTEGER NOT NULL DEFAULT 0,
  has_minor         INTEGER NOT NULL DEFAULT 0,
  guardian_consent  INTEGER NOT NULL DEFAULT 0,
  consent_note      TEXT,
  consented_at      TEXT,
  consented_by      TEXT REFERENCES staff_users(id),

  -- 公開してよいか。判定はここだけ (画面・API に再実装しない)
  online_ok INTEGER GENERATED ALWAYS AS
    (consent_shoot AND consent_online AND (NOT has_minor OR guardian_consent)) STORED,
  tv_ok INTEGER GENERATED ALWAYS AS
    (consent_shoot AND consent_tv AND (NOT has_minor OR guardian_consent)) STORED,

  status        TEXT NOT NULL DEFAULT 'preparing'
                CHECK (status IN ('preparing','published','hidden','deleted')),
  published_at  TEXT,
  tv_priority_at TEXT,
  created_by    TEXT REFERENCES staff_users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- 同意の無いグループは公開状態にできない (アプリのバグがあっても DB が止める)
  CHECK (status <> 'published'
         OR (consent_shoot AND consent_online AND (NOT has_minor OR guardian_consent)))
);
CREATE INDEX groups_date_idx ON groups(shoot_date DESC, start_time);

CREATE TABLE photos (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  taken_at      TEXT,
  sha256        TEXT NOT NULL,
  crc32         INTEGER,                          -- 原本の CRC32 (ZIP をほぼ CPU 無しで組み立てるため)
  original_key  TEXT NOT NULL,
  preview_key   TEXT NOT NULL,
  thumb_key     TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  status        TEXT NOT NULL DEFAULT 'ready'
                CHECK (status IN ('ready','hidden','pending_delete','deleted')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  previews_purged_at TEXT,                      -- 購入済み写真の閲覧期間終了後にプレビューだけ消した時刻
  deleted_at    TEXT
);
CREATE UNIQUE INDEX photos_group_sha_uq ON photos(group_id, sha256) WHERE status <> 'deleted';
CREATE INDEX photos_group_order_idx ON photos(group_id, taken_at, id) WHERE status IN ('ready','hidden');

CREATE TABLE tv_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  mode           TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual','off')),
  group_id       TEXT REFERENCES groups(id) ON DELETE SET NULL,
  slide_seconds  INTEGER NOT NULL DEFAULT 6   CHECK (slide_seconds BETWEEN 2 AND 60),
  group_seconds  INTEGER NOT NULL DEFAULT 60  CHECK (group_seconds BETWEEN 10 AND 600),
  tv_token       TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO tv_state(id) VALUES (1);

-- ---- 注文 (購入者ごとに独立) --------------------------------------------------
CREATE TABLE orders (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  order_token     TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  group_id        TEXT NOT NULL REFERENCES groups(id),
  email           TEXT NOT NULL COLLATE NOCASE CHECK (instr(email, '@') > 1),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed','canceled','expired',
                                    'refunded','partially_refunded','needs_review')),
  amount_jpy      INTEGER NOT NULL CHECK (amount_jpy > 0),
  photo_count     INTEGER NOT NULL CHECK (photo_count > 0),
  pack_applied    INTEGER NOT NULL DEFAULT 0,       -- 全写真パック (注文時点の公開写真すべて)
  pricing_snapshot TEXT NOT NULL CHECK (json_valid(pricing_snapshot)),
  cart_hash       TEXT NOT NULL,                    -- 写真セット+パックの指紋。二重注文の検出用
  stripe_session_id TEXT UNIQUE,
  paid_payment_id TEXT,                             -- この注文を成立させた payments.id
  review_reason   TEXT,
  paid_at         TEXT,
  download_expires_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 同じ購入者が同じ内容で未決済の注文を 2 本持てない (連打・再読込での二重注文を防ぐ)
CREATE UNIQUE INDEX orders_pending_cart_uq
  ON orders(group_id, email, cart_hash) WHERE status = 'pending';
CREATE INDEX orders_group_idx  ON orders(group_id);
CREATE INDEX orders_email_idx  ON orders(email);
CREATE INDEX orders_status_idx ON orders(status, created_at);
CREATE INDEX orders_paid_idx   ON orders(paid_at) WHERE paid_at IS NOT NULL;

-- 注文をまたぐ一意制約は無い = 同じ写真を何人にでも販売できる
CREATE TABLE order_items (
  id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  order_id  TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  photo_id  TEXT NOT NULL REFERENCES photos(id),
  group_id  TEXT NOT NULL REFERENCES groups(id),
  UNIQUE (order_id, photo_id)
);
CREATE INDEX order_items_photo_idx ON order_items(photo_id);

-- 支払い。1 注文に複数の支払いが付きうる (= 二重決済)。最初の 1 件が注文を成立させ、
-- 以降は review_reason='duplicate_payment' を付けて管理者が確認・返金する
CREATE TABLE payments (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  order_id              TEXT NOT NULL REFERENCES orders(id),
  stripe_session_id     TEXT,
  stripe_payment_intent TEXT NOT NULL UNIQUE,       -- 同じ支払いは 2 回記録できない
  amount_jpy            INTEGER NOT NULL CHECK (amount_jpy > 0),
  status                TEXT NOT NULL DEFAULT 'succeeded'
                        CHECK (status IN ('succeeded','refunded','partially_refunded')),
  review_reason         TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX payments_order_idx ON payments(order_id);

CREATE TABLE refunds (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  payment_id        TEXT NOT NULL REFERENCES payments(id),
  order_id          TEXT NOT NULL REFERENCES orders(id),
  stripe_refund_id  TEXT UNIQUE,
  amount_jpy        INTEGER NOT NULL CHECK (amount_jpy > 0),
  reason            TEXT,
  staff_id          TEXT REFERENCES staff_users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE stripe_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE download_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  photo_id  TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('single','zip')),
  ip_hash   TEXT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE takedown_requests (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  group_id    TEXT REFERENCES groups(id) ON DELETE SET NULL,
  photo_id    TEXT REFERENCES photos(id) ON DELETE SET NULL,
  requester   TEXT,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')),
  handled_by  TEXT REFERENCES staff_users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  handled_at  TEXT
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    TEXT REFERENCES staff_users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_at_idx ON audit_logs(at DESC);

-- ---- 分析ビュー ---------------------------------------------------------------
-- 同じ写真が複数人に売れるので「売れた延べ枚数」と「売れた写真の種類数」を分けて持つ。
-- 全写真パックは団体全員分なので、人数あたりの売上・購入者数も見る。
CREATE VIEW v_group_sales AS
SELECT
  g.id AS group_id, g.shoot_date, g.start_time, g.name, g.headcount, g.plan,
  (SELECT count(*) FROM photos p WHERE p.group_id = g.id AND p.status = 'ready') AS photo_count,
  count(o.id)                                          AS paid_orders,
  count(DISTINCT o.email)                              AS buyers,
  coalesce(sum(o.pack_applied), 0)                     AS pack_orders,
  coalesce(sum(o.photo_count), 0)                      AS items_sold,
  coalesce(sum(o.amount_jpy), 0)                       AS revenue_jpy,
  CASE WHEN g.headcount > 0 THEN round(coalesce(sum(o.amount_jpy), 0) * 1.0 / g.headcount) END
                                                       AS revenue_per_head_jpy,
  (SELECT count(*) FROM orders x WHERE x.group_id = g.id AND x.status = 'needs_review')
                                                       AS needs_review_orders,
  CASE WHEN count(o.id) > 0 THEN 1 ELSE 0 END          AS has_purchase
FROM groups g
LEFT JOIN orders o ON o.group_id = g.id AND o.status IN ('paid','partially_refunded')
WHERE g.status <> 'deleted'
GROUP BY g.id;

CREATE VIEW v_daily_sales AS
SELECT substr(datetime(o.paid_at, '+9 hours'), 1, 10) AS sale_date,
       count(*) AS orders, sum(o.amount_jpy) AS revenue_jpy, sum(o.photo_count) AS items_sold,
       sum(o.pack_applied) AS pack_orders
FROM orders o
WHERE o.status IN ('paid','partially_refunded')
GROUP BY 1;

-- 重複決済・金額不一致など、管理者が見るべき支払い
CREATE VIEW v_payments_to_review AS
SELECT p.id AS payment_id, p.order_id, o.email, o.status AS order_status, p.amount_jpy,
       p.review_reason, p.created_at
FROM payments p JOIN orders o ON o.id = p.order_id
WHERE p.review_reason IS NOT NULL AND p.status = 'succeeded';
