-- =========================================================================
-- 0009_reservation_number_default.sql
-- -------------------------------------------------------------------------
-- Give reservations.reservation_number a DB DEFAULT so the API endpoint
-- can INSERT without pre-computing an ID.
--
-- Format: KK-YYMMDD-XXXX
--   YYMMDD: JST calendar day the row was created
--   XXXX  : 4 uppercase hex chars derived from a fresh UUID
--
-- Uniqueness is enforced by the UNIQUE constraint from 0001; the 65 536-
-- state suffix keeps day-level collisions vanishingly unlikely (birthday
-- paradox → ~2.5% for ~30 same-day bookings, which we're far below).
--
-- Idempotent: `SET DEFAULT` replaces whatever default is in place.
-- =========================================================================

ALTER TABLE reservations
  ALTER COLUMN reservation_number
  SET DEFAULT (
    'KK-' ||
    to_char(now() AT TIME ZONE 'Asia/Tokyo', 'YYMMDD') ||
    '-' ||
    upper(substring(md5(gen_random_uuid()::text), 1, 4))
  );
