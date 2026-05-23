import { createLogger } from "@/lib/logging";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AlwaysOnSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SentryContextManager } from "@sentry/node-core";
import type { NodeClient } from "@sentry/node-core";
import { SentryPropagator, SentrySpanProcessor, getSentryResource } from "@sentry/opentelemetry";

const logger = createLogger("telemetry.otel-setup");

function langfuseProcessors(): SpanProcessor[] {
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
 * Sentry + Langfuse 共存 OTel セットアップ。
 *
 * 経緯: Sentry の `initOpenTelemetry` は `SentrySampler` を使うが、
 *       SentrySampler は `tracesSampleRate: 0.0` のとき span を NOT_RECORD に落とすため
 *       後段の LangfuseSpanProcessor の onEnd が呼ばれず、Langfuse に trace が届かない。
 *       かといって tracesSampleRate を上げると Sentry billing が増える。
 *
 * 対処: 自前で BasicTracerProvider を組み、Sampler を AlwaysOnSampler に差し替え。
 *       SentrySpanProcessor は LangfuseSpanProcessor と同じ provider に並列登録し、
 *       Sentry 側の sampling は SentrySpanProcessor 内部で扱われる
 *       (Sentry に送るかは tracesSampleRate ベースで判断、Langfuse には全 span 流れる)。
 *
 * 呼び出し側は Sentry.init({ skipOpenTelemetrySetup: true }) で Sentry 既定の OTel を抑止し、
 * この関数を呼ぶ。
 */
export function setupOtelWithSentry(client: NodeClient): void {
  const lfProcs = langfuseProcessors();

  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: getSentryResource("node"),
    forceFlushTimeoutMillis: 500,
    spanProcessors: [new SentrySpanProcessor(), ...lfProcs],
  });

  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new SentryPropagator());

  const ctxManager = new SentryContextManager();
  otelContext.setGlobalContextManager(ctxManager);

  client.traceProvider = provider;
  client.asyncLocalStorageLookup = ctxManager.getAsyncLocalStorageLookup();

  logger.info(
    { langfuseEnabled: lfProcs.length > 0 },
    "OTel TracerProvider initialized (Sentry + Langfuse)",
  );
}
