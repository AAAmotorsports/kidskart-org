-- =========================================================================
-- 0005_grant_service_role.sql
-- -------------------------------------------------------------------------
-- Grant `service_role` (the JWT that server-side code uses via
-- SUPABASE_SERVICE_ROLE_KEY) full access to every table, sequence and
-- function in the public schema.
--
-- The Supabase project template pre-configures this, but tables and
-- functions created by hand later inherit only whatever ALTER DEFAULT
-- PRIVILEGES was in force when the CREATE ran — so migrations 0001..0004
-- ended up with `authenticated` granted (matching the RLS staff policies)
-- but nothing for `service_role`.
--
-- Why the RLS-bypass isn't enough on its own: BYPASSRLS lets service_role
-- skip the row filter, but the underlying `GRANT SELECT/INSERT/…` still
-- has to be present or the query dies at 42501 before RLS is ever
-- consulted. This is exactly what generate_slots_for_month tripped on
-- when trying to read schedule_exceptions from inside a SECURITY INVOKER
-- function.
--
-- Idempotent — GRANT to an already-granted role is a no-op.
-- =========================================================================

GRANT USAGE ON SCHEMA public TO service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Any table/function added by a future migration also gets service_role
-- access automatically (only affects objects created AFTER this runs, so
-- the two blanket GRANTs above handle existing objects).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- Verify: service_role should now appear on schedule_exceptions and every
-- other public table.
SELECT
  table_name,
  string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'service_role'
GROUP BY table_name
ORDER BY table_name;
