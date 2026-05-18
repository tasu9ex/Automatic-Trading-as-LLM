import { createLogger } from "@/lib/logging";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK, resources } from "@opentelemetry/sdk-node";

const logger = createLogger("telemetry.otel-setup");

/**
 * OpenTelemetry + Langfuse OTel exporter のセットアップ。
 *
 * AI SDK の `experimental_telemetry: { isEnabled: true }` が自動的に span を生成し、
 * LangfuseSpanProcessor 経由で Langfuse Cloud に送信される。
 *
 * 必要 env:
 *   LANGFUSE_PUBLIC_KEY
 *   LANGFUSE_SECRET_KEY
 *   LANGFUSE_BASE_URL (optional, default https://cloud.langfuse.com)
 *
 * 未設定なら no-op。
 */

let sdk: NodeSDK | null = null;
let started = false;

export function initTelemetry(): void {
  if (started) return;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    logger.warn("Langfuse keys not set, telemetry disabled");
    return;
  }

  sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({ "service.name": "automatic-trading-as-llm" }),
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
      }),
    ],
  });

  sdk.start();
  started = true;
  logger.info("Telemetry started (Langfuse OTel)");
}

/**
 * プロセス終了前に呼ぶ。span を flush して shutdown。
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk || !started) return;
  try {
    await sdk.shutdown();
    logger.info("Telemetry shutdown complete");
  } catch (err) {
    logger.warn({ err }, "Telemetry shutdown failed");
  }
  started = false;
}
