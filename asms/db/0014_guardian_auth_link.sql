-- 0014_guardian_auth_link.sql
--
-- Magic Link 認証: 別端末リピーターが再ログイン時に、
-- guardians 行と Supabase Auth (auth.users) を紐付けるための列。
--
-- 設計:
-- - NULL 許容 = 未 auth 化。既存の guardians は全部 NULL からスタート。
-- - UNIQUE = 1 保護者 = 1 auth user (重複 auth user は許さない)。
-- - ON DELETE SET NULL = auth.users が消えても guardians は残す
--   (キャンセルメールや当日連絡の履歴を失いたくない)。
-- - サインイン時に email 一致で自動リンクする (API 側で処理)。
-- - Passkey 移行時も同じ列を使い回す (auth.users.id は変わらない)。

alter table guardians
  add column if not exists auth_user_id uuid
    references auth.users(id) on delete set null;

create unique index if not exists idx_guardians_auth_user_id
  on guardians(auth_user_id)
  where auth_user_id is not null;

comment on column guardians.auth_user_id is
  'Supabase Auth user ID. NULL = 未リンク。Magic Link 初回サインイン時に email 一致で自動紐付け。';
