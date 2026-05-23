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
 * Tier 3 は JPY 絶対値を見ない方針:
 *   - size_pct は「max を 100 とした時の何 %」(抽象値)
 *   - JPY 化はコード (Allocator + Clipper) の責任
 */
export const EntryDecisionOutputSchema = z.object({
  decision: z.enum(ENTRY_DECISIONS),
  confidence: z.number().min(0).max(1),
  /** Buy 時のサイズ指定 (1-100 整数 %、max の何 % 使うか)。decision === "no" のときは null。 */
  size_pct: z.number().int().min(1).max(100).nullable(),
  reasoning: z.string(),
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
  /** Critic 自身の判断確信度 (観測用) */
  confidence: z.number().min(0).max(1),
  /**
   * modify 時のみ非 null:
   *   buys:  symbol → 修正後 size_pct (0-100 整数 %、Entry の size_pct を上書き、0 で除外)
   *   exits: symbol → 修正後 close_pct (10-100 整数 %、Tier 3 の close_pct を上書き)
   *           close 中止したいなら veto を使う (exits 操作では止められない)
   * 修正不要な銘柄は省略可。approve / veto のときは null。
   */
  adjustments: z
    .object({
      buys: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
      exits: z.record(z.string(), z.number().int().min(10).max(100)).optional(),
    })
    .nullable(),
  reasoning: z.string(),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

/** Allocator の出力 (内部) */
export type AllocationProposal = Record<string, number>; // symbol → jpy
