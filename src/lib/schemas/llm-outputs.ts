import {
  CRITIC_DECISIONS,
  ENTRY_DECISIONS,
  EXIT_DECISIONS,
  MARKET_DIRECTIONS,
} from "@/lib/constants/enums";
import { z } from "zod";

/** Tier 1 Pre-Analyst の出力 */
export const PreAnalystOutputSchema = z.object({
  summary: z.string(),
  skip_flag: z.boolean(),
  reasoning: z.string(),
});
export type PreAnalystOutput = z.infer<typeof PreAnalystOutputSchema>;

/** Tier 2 Analyst の出力 (セクション別) */
export const AnalystOutputSchema = z.object({
  fundamental: z.object({
    notes: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  sentiment: z.object({
    notes: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  technical: z.object({
    notes: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  synthesis: z.object({
    direction: z.enum(MARKET_DIRECTIONS),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

/**
 * Entry Decision の出力 (DECISION_RESULTS の部分集合)。
 *
 * Entry 仮説 3 つ (`expected_*`, `target_price_jpy`, `exit_condition`) は
 * **緩い参考値** として記録される。Exit 側で anchor 化を避けるため、
 * Exit プロンプトは「reference のみ、anchor 禁止」と明示する。
 *
 * "no" 判定時は仮説フィールドは null。
 */
export const EntryDecisionOutputSchema = z.object({
  decision: z.enum(ENTRY_DECISIONS),
  confidence: z.number().min(0).max(1),
  /**
   * Buy 時のサイズ指定 (1-100 整数 %)。
   *   actual_buy_jpy = max_budget_jpy × (size_pct / 100)
   * max_budget_jpy はコード側 (現金 × perCoinMaxRatio) で計算して prompt に渡す。
   * decision === "no" のときは null。
   */
  size_pct: z.number().int().min(1).max(100).nullable(),
  reasoning: z.string(),
  expected_holding_days: z
    .object({
      min: z.number().int().min(1),
      max: z.number().int().min(1),
    })
    .nullable(),
  target_price_jpy: z.number().positive().nullable(),
  exit_condition: z.string().max(300).nullable(),
});
export type EntryDecisionOutput = z.infer<typeof EntryDecisionOutputSchema>;

/** Exit Decision の出力 (DECISION_RESULTS の部分集合) */
export const ExitDecisionOutputSchema = z.object({
  decision: z.enum(EXIT_DECISIONS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  /**
   * close 時の決済比率 (% 整数、10-100)。100 = 全決済、<100 = 部分決済。
   * decision === "hold" のときは無視 (LLM が値を入れても OK)。
   * 省略時は 100 として扱う (後方互換)。
   */
  close_pct: z.number().int().min(10).max(100).default(100),
});
export type ExitDecisionOutput = z.infer<typeof ExitDecisionOutputSchema>;

/** Critic の出力 */
export const CriticOutputSchema = z.object({
  decision: z.enum(CRITIC_DECISIONS),
  /**
   * modify 時のみ非 null:
   *   buys:  symbol → 修正後 JPY 額 (Allocator 提案を上書き)
   *   exits: symbol → 修正後 close 比率 % (10-100 整数、Tier 3 の close_pct を上書き)
   *           値 0 は意味なし (実装側で 10 にクランプ)、close 中止したいなら veto を使う
   * 修正不要な銘柄は省略可。approve / veto は null。
   */
  adjustments: z
    .object({
      buys: z.record(z.string(), z.number()).optional(),
      exits: z.record(z.string(), z.number().int().min(10).max(100)).optional(),
    })
    .nullable(),
  reasoning: z.string(),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

/** Allocator の出力 (内部) */
export type AllocationProposal = Record<string, number>; // symbol → jpy
