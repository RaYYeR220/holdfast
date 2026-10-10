-- The fencing token of the tick lease. Whoever takes the lease writes a fresh
-- token here, and a tick may only write while its own token is still the one
-- on the row. Safe to run again.
ALTER TABLE "holdfast"."orgs" ADD COLUMN IF NOT EXISTS "tick_lease_token" uuid;
