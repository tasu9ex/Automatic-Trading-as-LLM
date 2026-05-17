-- Enable Row Level Security on all 13 tables.
--
-- Connection model:
--   - Drizzle / CLI / Inngest worker connect as `postgres` (superuser, bypasses RLS).
--   - Future client-side reads will go through supabase-js with `anon` / `authenticated`
--     and MUST respect these policies.
--   - Supabase's service_role JWT also bypasses RLS by default config.
--
-- Policy strategy (personal-use MVP):
--   - anon:           denied (no policies = implicit deny when RLS is on)
--   - authenticated:  SELECT-only on all tables (read-only UI access in Phase C)
--   - service_role:   bypasses (no policy needed)
--   - Mutations:      always via server (Drizzle), never from client

-- ------------------------------------------------------------
-- Enable RLS
-- ------------------------------------------------------------
ALTER TABLE "coins"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "market_snapshots"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pre_analyst_outputs"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analyst_outputs"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decisions"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_orders"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "positions"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trades"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_events"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "critic_outputs"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolios"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "system_state"         ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- authenticated: SELECT-only on every table
-- ------------------------------------------------------------
CREATE POLICY "authenticated_select" ON "coins"                FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "market_snapshots"     FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "pre_analyst_outputs"  FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "analyst_outputs"      FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "decisions"            FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "orders"               FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "pending_orders"       FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "positions"            FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "trades"               FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "system_events"        FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "critic_outputs"       FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "portfolios"           FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "authenticated_select" ON "system_state"         FOR SELECT TO "authenticated" USING (true);
