-- =========================================================================
-- 0003_grant_permissions.sql
-- -------------------------------------------------------------------------
-- Fills in the table-level GRANTs that 0001_initial_schema.sql omitted.
--
-- Row Level Security only takes effect once PostgreSQL has already granted
-- the underlying SELECT/INSERT/UPDATE/DELETE privilege to the role; without
-- GRANT the row filter is never reached and the query dies with
-- "42501: permission denied for table ...".
--
-- Idempotent: repeated runs are safe (GRANT ... TO role on the same target
-- is a no-op if already present).
-- =========================================================================

-- ---- Public read (anon + authenticated) ---------------------------------
-- These three tables carry PERMISSIVE public_read policies in 0001; grant
-- the base SELECT so the RLS filter actually gets evaluated.
GRANT SELECT ON courses TO anon, authenticated;
GRANT SELECT ON slots    TO anon, authenticated;
GRANT SELECT ON terms    TO anon, authenticated;

-- ---- Staff (authenticated role) full access -----------------------------
-- Everything else is staff-only. The service_role bypass covers server-side
-- API endpoints; grant to `authenticated` so a logged-in staff user going
-- straight through Supabase Auth can operate the admin console.
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

-- Sequence privileges (id defaults would fail without USAGE)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Verify
SELECT
  table_name,
  string_agg(DISTINCT grantee || ':' || privilege_type, ', ' ORDER BY grantee || ':' || privilege_type) AS grants
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
GROUP BY table_name
ORDER BY table_name;
