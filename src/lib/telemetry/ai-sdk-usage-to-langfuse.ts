import { createLogger } from "@/lib/logging";
import { trace } from "@opentelemetry/api";

const logger = createLogger("telemetry.ai-sdk-usage");

/** Vercel AI SDK の usage の shape (バージョン差を吸収) */
export interface AISdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface AttachOptions {
  /** モデル ID (Langfuse 側で pricing 解決される) */
  modelId: string;
  /** 機能名 (例: "tier2.analyst", "critic") */
  feature: string;
  /** 銘柄など追加メタ */
  extraMetadata?: Record<string, string | number | boolean>;
}

/**
 * AI SDK / Tier 0 クライアントの usage を構造化ログ + Langfuse span に記録。
 *
 * cost 計算は Langfuse 側に一元化 (Settings → Models で登録した単価から自動算出)。
 * ローカルでは tokens + model のみログ出力 (CLI での即時 cost 表示はなし)。
 */
export function recordLLMCall(usage: AISdkUsage | null | undefined, opts: AttachOptions): void {
  if (!usage) {
    logger.warn({ feature: opts.feature, modelId: opts.modelId }, "No usage reported");
    return;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  logger.info(
    {
      feature: opts.feature,
      modelId: opts.modelId,
      inputTokens,
      outputTokens,
      ...opts.extraMetadata,
    },
    "LLM call",
  );

  // Langfuse span に usage + model を attach (cost は Langfuse 側で自動計算)
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes({
      "langfuse.observation.usage_details.input": inputTokens,
      "langfuse.observation.usage_details.output": outputTokens,
      "langfuse.observation.usage_details.total": inputTokens + outputTokens,
      "langfuse.observation.model.name": opts.modelId,
    });
  }
}
