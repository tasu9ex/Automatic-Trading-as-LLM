ALTER TABLE "system_events" ADD COLUMN "cycle_id" uuid;--> statement-breakpoint
-- P-5: 既存行を payload->>'cycleId' から backfill (UUID 形式のみ、それ以外は NULL のまま)
UPDATE "system_events"
SET "cycle_id" = (payload->>'cycleId')::uuid
WHERE "cycle_id" IS NULL
  AND payload ? 'cycleId'
  AND payload->>'cycleId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';--> statement-breakpoint
CREATE INDEX "critic_outputs_created_at_idx" ON "critic_outputs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "system_events_cycle_id_idx" ON "system_events" USING btree ("cycle_id");