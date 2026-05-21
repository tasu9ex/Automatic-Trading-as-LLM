-- Critic レビュー対象を「raw 配分案」から「実行計画」(Exit dry-run + Allocator + Clipper 適用済) に変更。
-- 旧 allocation_proposal は drop。実行計画は ExecutionPlan jsonb として保存。
-- modified_positions は Critic modify 適用後のポジション見込み (symbol → jpy)。
--
-- データ移行: 過去 critic_outputs 行は廃棄 (ユーザー合意済、本番ログ少ない時期のため)。
-- 子参照 (cycle_id) はあるが FK ではないので孤児にはならない (cycles 側は別途 join で表示)。

DELETE FROM "critic_outputs";--> statement-breakpoint

ALTER TABLE "critic_outputs" DROP COLUMN "allocation_proposal";--> statement-breakpoint
ALTER TABLE "critic_outputs" ADD COLUMN "execution_plan" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "critic_outputs" ADD COLUMN "modified_positions" jsonb;
