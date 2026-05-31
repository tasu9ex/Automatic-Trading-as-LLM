import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "@/lib/logging";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const logger = createLogger("telemetry.ai-sdk-usage");

/**
 * サイクル単位のメタデータ伝播 (recordLLMCall が Langfuse span に付与する用)。
 * runJudgmentCycle 開始時に setSessionId 経由でセット。
 */
const sessionStore = new AsyncLocalStorage<{ sessionId: string }>();

export function runWithSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return sessionStore.run({ sessionId }, fn);
}

export function getCurrentSessionId(): string | undefined {
  return sessionStore.getStore()?.sessionId;
}

/** Vercel AI SDK の usage の shape (バージョン差を吸収) */
export interface AISdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  /**
   * プロバイダが返す実課金額 (USD)。Tier 0 の Grok / Perplexity はトークン代に加え
   * server-side tool / 検索 request fee が乗るため、API 返却の実額をそのまま計上する。
   * 指定時は Langfuse の単価推定を上書き (gen_ai.usage.cost として export)。
   */
  costUsd?: number | undefined;
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

  // Langfuse span に usage を attach (model 名は AI SDK が gen_ai.response.model で
  // 報告する dated 形式 = "claude-haiku-4-5-20251001" を Langfuse pricing 認識に使うため
  // ここで catalog 形式 "claude-haiku-4-5" を上書きしない)
  const span = trace.getActiveSpan();
  if (span) {
    const session = sessionStore.getStore();
    span.setAttributes({
      "langfuse.observation.usage_details.input": inputTokens,
      "langfuse.observation.usage_details.output": outputTokens,
      "langfuse.observation.usage_details.total": inputTokens + outputTokens,
      ...(session ? { "langfuse.session.id": session.sessionId } : {}),
    });
  }
}

/**
 * AI SDK 経由でない呼び出し (Tier 0 の Perplexity / Grok 等) を Langfuse trace に乗せる。
 *
 * AI SDK は experimental_telemetry で span を自動生成するが、raw fetch クライアントは
 * span を作らない。ここで明示的に generation span を作り、Langfuse 側で cost 集計可能にする。
 */
export async function withGenerationSpan<T>(
  opts: AttachOptions,
  fn: () => Promise<{ result: T; usage: AISdkUsage | null | undefined }>,
): Promise<T> {
  const tracer = trace.getTracer("tier0.manual");
  const session = sessionStore.getStore();
  return tracer.startActiveSpan(opts.feature, async (span) => {
    // gen_ai.* attribute を付けると LangfuseSpanProcessor が export する (isGenAISpan 判定)
    span.setAttributes({
      "gen_ai.system": opts.modelId,
      "gen_ai.request.model": opts.modelId,
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": opts.modelId,
      "langfuse.trace.name": opts.feature,
      ...(session ? { "langfuse.session.id": session.sessionId } : {}),
    });
    try {
      const { result, usage } = await fn();
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      span.setAttributes({
        // OTel semconv (Langfuse はここから usage を読む)
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        // Langfuse 独自 (補完)
        "langfuse.observation.usage_details.input": inputTokens,
        "langfuse.observation.usage_details.output": outputTokens,
        "langfuse.observation.usage_details.total": inputTokens + outputTokens,
      });
      // プロバイダ返却の実課金額があれば cost として明示 (トークン + 検索/ツール代込み)。
      // gen_ai.usage.cost が Langfuse の単価推定を上書きする (cost_details は OTel 経由で
      // 効かない既知バグ #11030 のため gen_ai.usage.cost を使う)。
      if (usage?.costUsd != null) {
        span.setAttribute("gen_ai.usage.cost", usage.costUsd);
      }
      logger.info(
        {
          feature: opts.feature,
          modelId: opts.modelId,
          inputTokens,
          outputTokens,
          costUsd: usage?.costUsd,
          ...opts.extraMetadata,
        },
        "LLM call",
      );
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
