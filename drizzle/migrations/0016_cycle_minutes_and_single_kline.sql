-- Cycle interval を「時間」から「分」に変更 + Kline を primary/long 二段 → 単一に簡素化。
-- 詳細:
--   1) system_state.cycle_interval_hours → cycle_interval_minutes (値も *60 で変換)
--      旧 1/3/6/24h のうち、3/6h は新オプション (30/60/240/480/720/1440min) に
--      含まれないので、近い値にスナップ: 3h(180min)→4h(240min) / 6h(360min)→8h(480min)。
--   2) market_snapshots: primary/long の二段 (ohlcv_primary, ohlcv_long, primary_interval, long_interval)
--      → 単一 (ohlcv, kline_interval) にリネーム + 不要列 drop。旧データは新カラム名に移行
--      (ohlcv_primary → ohlcv, primary_interval → kline_interval) しつつ long 系は drop。

ALTER TABLE "system_state" RENAME COLUMN "cycle_interval_hours" TO "cycle_interval_minutes";--> statement-breakpoint
UPDATE "system_state" SET "cycle_interval_minutes" = "cycle_interval_minutes" * 60;--> statement-breakpoint
UPDATE "system_state" SET "cycle_interval_minutes" = 240 WHERE "cycle_interval_minutes" = 180;--> statement-breakpoint
UPDATE "system_state" SET "cycle_interval_minutes" = 480 WHERE "cycle_interval_minutes" = 360;--> statement-breakpoint
ALTER TABLE "system_state" ALTER COLUMN "cycle_interval_minutes" SET DEFAULT 1440;--> statement-breakpoint

ALTER TABLE "market_snapshots" RENAME COLUMN "ohlcv_primary" TO "ohlcv";--> statement-breakpoint
ALTER TABLE "market_snapshots" RENAME COLUMN "primary_interval" TO "kline_interval";--> statement-breakpoint
ALTER TABLE "market_snapshots" DROP COLUMN "ohlcv_long";--> statement-breakpoint
ALTER TABLE "market_snapshots" DROP COLUMN "long_interval";
