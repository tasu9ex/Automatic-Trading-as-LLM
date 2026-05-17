import { createLogger } from "@/lib/logging";

const logger = createLogger("telemetry.cost-tracking");

/** LLM 1 リクエストあたりの input/output トークン量 */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * モデル ID → 単価 (USD per 1M tokens)。
 * 公式価格を反映、変動するため定期更新が必要。
 *
 * 円換算は USD_TO_JPY を変更するだけで全更新される。
 */
const USD_TO_JPY = 150;

interface ModelPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-opus-4-7": { inputPerMTokens: 15, outputPerMTokens: 75 },
  "claude-sonnet-4-6": { inputPerMTokens: 3, outputPerMTokens: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTokens: 0.8, outputPerMTokens: 4 },

  // Google
  "gemini-2.5-pro": { inputPerMTokens: 1.25, outputPerMTokens: 10 },
  "gemini-2.5-flash": { inputPerMTokens: 0.3, outputPerMTokens: 2.5 },
};

export interface CostBreakdown {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  totalJpy: number;
}

/**
 * モデル ID とトークン量から金額を計算。
 * 未知モデルは null。
 */
export function calculateCost(modelId: string, usage: LLMUsage): CostBreakdown | null {
  const pricing = PRICING[modelId];
  if (!pricing) {
    logger.warn({ modelId }, "Unknown model in PRICING table");
    return null;
  }
  const inputUsd = (usage.inputTokens / 1_000_000) * pricing.inputPerMTokens;
  const outputUsd = (usage.outputTokens / 1_000_000) * pricing.outputPerMTokens;
  const totalUsd = inputUsd + outputUsd;
  return {
    modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputUsd,
    outputUsd,
    totalUsd,
    totalJpy: totalUsd * USD_TO_JPY,
  };
}

/** USD → JPY 換算レート(価格表更新時に合わせて見直すこと) */
export function getUsdToJpyRate(): number {
  return USD_TO_JPY;
}

/** PRICING テーブルに追加・上書き(テストや動的更新用) */
export function setModelPricing(modelId: string, pricing: ModelPricing): void {
  PRICING[modelId] = pricing;
}
