import { createLogger } from "@/lib/logging";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

const logger = createLogger("telemetry.otel-setup");

/**
 * Sentry + Langfuse 共存設定。
 *
 * 経緯: 旧版は NodeSDK で独自に TracerProvider をグローバル登録していたが、
 *       Sentry が instrumentation.ts (Next.js) で先に TracerProvider を握ると
 *       Langfuse の processor が反映されず、本番から trace が届かない状態だった。
 *
 * 新版: Sentry.init の `openTelemetrySpanProcessors` オプション (v10+) で
 *       Sentry の TracerProvider に LangfuseSpanProcessor を co-processor として
 *       相乗りさせる。Sentry / Langfuse 両方が同じ span を受け取る。
 *
 * 必要 env:
 *   LANGFUSE_PUBLIC_KEY
 *   LANGFUSE_SECRET_KEY
 *   LANGFUSE_BASE_URL (optional, default https://cloud.langfuse.com)
 *
 * 未設定なら空配列を返し、Langfuse 側は no-op。
 */
export function langfuseProcessors(): SpanProcessor[] {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    logger.warn("Langfuse keys not set, Langfuse OTel disabled");
    return [];
  }
  return [
    new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
      // 短命 serverless で span flush 前に終了するのを防ぐ
      exportMode: "immediate",
    }),
  ];
}

/**
 * @deprecated Sentry.init の openTelemetrySpanProcessors で代替。残置は後方互換のため。
 * Sentry が OTel TracerProvider のオーナーになったので、別途 NodeSDK を立てる必要なし。
 */
export function initTelemetry(): void {
  // no-op
}

/**
 * @deprecated shutdownSentry が co-processor の flush も担う。
 */
export async function shutdownTelemetry(): Promise<void> {
  // no-op
}
