import {
  CRITIC_DECISIONS,
  ENTRY_DECISIONS,
  EXIT_DECISIONS,
  FUNDAMENTAL_IMPACTS,
  MARKET_DIRECTIONS,
  SENTIMENT_TONES,
  SENTIMENT_TRENDS,
  TECHNICAL_TRENDS,
  VOLATILITY_LEVELS,
} from "@/lib/constants/enums";
import { z } from "zod";

/** Tier 1 Pre-Analyst の出力 */
export const PreAnalystOutputSchema = z.object({
  summary: z.string(),
  relevance_score: z.number().min(0).max(1),
  skip_flag: z.boolean(),
  reasoning: z.string(),
});
export type PreAnalystOutput = z.infer<typeof PreAnalystOutputSchema>;

/** Tier 2 Analyst の出力 (セクション別) */
export const AnalystOutputSchema = z.object({
  fundamental: z.object({
    key_events: z.array(z.string()),
    impact: z.enum(FUNDAMENTAL_IMPACTS),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
  }),
  sentiment: z.object({
    tone: z.enum(SENTIMENT_TONES),
    trend: z.enum(SENTIMENT_TRENDS),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
  }),
  technical: z.object({
    trend: z.enum(TECHNICAL_TRENDS),
    support: z.string(),
    resistance: z.string(),
    volatility: z.enum(VOLATILITY_LEVELS),
    confidence: z.number().min(0).max(1),
    notes: z.string(),
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
});
export type ExitDecisionOutput = z.infer<typeof ExitDecisionOutputSchema>;

/** Critic の出力 */
export const CriticOutputSchema = z.object({
  decision: z.enum(CRITIC_DECISIONS),
  adjustments: z.record(z.string(), z.number()).nullable(),
  reasoning: z.string(),
});
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

/** Allocator の出力 (内部) */
export type AllocationProposal = Record<string, number>; // symbol → jpy
