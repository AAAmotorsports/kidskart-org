-- =========================================================================
-- 0010_fix_cancel_token_encoding.sql
-- -------------------------------------------------------------------------
-- Fix "22023 unrecognized encoding: base64url" that fires when INSERTing
-- into reservations.
--
-- 0001 declared:
--   cancel_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'base64url')
--
-- but `base64url` is a very new PostgreSQL codec — Supabase's platform
-- Postgres doesn't accept it, so any row INSERT that hits the DEFAULT
-- errors out before the row is written. Replace the DEFAULT with a
-- URL-safe base64 built from the legacy `base64` codec + `translate`
-- (swap `+` → `-`, `/` → `_`). 24 random bytes is 32 base64 chars with
-- no `=` padding, so no rtrim needed.
--
-- Idempotent — ALTER COLUMN … SET DEFAULT replaces whatever's there.
-- =========================================================================

ALTER TABLE reservations
  ALTER COLUMN cancel_token
  SET DEFAULT translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
