-- =========================================================================
-- 0002_bootstrap_master.sql
-- -------------------------------------------------------------------------
-- Run this AFTER the master user has signed up via Supabase Auth
-- (Authentication → Users → Add user, or via the app's login flow).
--
-- Wires the auth.users row to a staff row with owner role.
-- Safe to re-run; ON CONFLICT DO UPDATE keeps role/name in sync.
-- =========================================================================

INSERT INTO staff (auth_user_id, email, name, role, is_active)
VALUES (
  (SELECT id FROM auth.users WHERE email = 'masaaki_0820@me.com'),
  'masaaki_0820@me.com',
  'マスター',
  'owner',
  true
)
ON CONFLICT (email) DO UPDATE
  SET auth_user_id = EXCLUDED.auth_user_id,
      name         = EXCLUDED.name,
      role         = EXCLUDED.role,
      is_active    = EXCLUDED.is_active,
      updated_at   = now();

-- Verify
SELECT id, email, name, role, is_active, auth_user_id
FROM staff
WHERE email = 'masaaki_0820@me.com';
