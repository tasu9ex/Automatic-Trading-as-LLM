ALTER TABLE "system_state" ADD COLUMN "cycle_interval_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "next_scheduled_at" timestamp with time zone;