import { createLogger } from "@/lib/logging";
import { type LLMUsage, calculateCost } from "./cost-tracking";

const logger = createLogger("telemetry.ai-sdk-usage");

/** Vercel AI SDK の usage の shape (バージョン差を吸収) */
export interface AISdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface AttachOptions {
  /** モデル ID (PRICING に登録済みのもの) */
  modelId: string;
  /** 機能名 (例: "tier2.analyst", "critic") */
  feature: string;
  /** 銘柄など追加メタ */
  extraMetadata?: Record<string, string | number | boolean>;
}

/**
 * AI SDK の usage を構造化ログに出力。
 * Phase B で Langfuse client / OTel が入ったらここから span attribute も振る。
 *
 * 当面はログだけだが、シグネチャを安定させて呼び出し側を将来書き換えなくて済むようにする。
 */
export function recordLLMCall(usage: AISdkUsage | null | undefined, opts: AttachOptions): void {
  if (!usage) {
    logger.warn({ feature: opts.feature, modelId: opts.modelId }, "No usage reported");
    return;
  }

  const normalized: LLMUsage = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };

  const cost = calculateCost(opts.modelId, normalized);

  logger.info(
    {
      feature: opts.feature,
      modelId: opts.modelId,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      totalUsd: cost?.totalUsd,
      totalJpy: cost?.totalJpy,
      ...opts.extraMetadata,
    },
    "LLM call",
  );

  // TODO(Phase B): Langfuse span への attach
  //   const span = trace.getActiveSpan();
  //   if (span) {
  //     span.setAttributes({
  //       "langfuse.observation.usage_details.input": normalized.inputTokens,
  //       "langfuse.observation.usage_details.output": normalized.outputTokens,
  //       "langfuse.observation.cost_details.total": cost?.totalUsd ?? 0,
  //     });
  //   }
}
