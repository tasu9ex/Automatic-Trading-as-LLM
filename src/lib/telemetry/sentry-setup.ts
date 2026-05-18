import { createLogger } from "@/lib/logging";
import * as Sentry from "@sentry/node";

const logger = createLogger("telemetry.sentry-setup");

let initialized = false;

/**
 * Sentry Node SDK 初期化 (CLI / Inngest ワーカー用)。
 *
 * 必要 env:
 *   NEXT_PUBLIC_SENTRY_DSN (Phase C で Next.js も共通 DSN で OK)
 *
 * 未設定なら no-op。Discord への通知は Sentry Dashboard 側で:
 *   Settings → Integrations → Discord → 接続
 *   Alerts → Create Alert Rule → 通知先に Discord 選択
 * で連携する(コード側で追加実装不要)。
 */
export function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    logger.warn("NEXT_PUBLIC_SENTRY_DSN not set, Sentry disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.0, // OTel/Langfuse 側で trace するので、Sentry tracing は無効
    integrations: [],
    sendDefaultPii: false,
  });

  initialized = true;
  logger.info("Sentry initialized");
}

export async function shutdownSentry(): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.close(2000);
    logger.info("Sentry shutdown complete");
  } catch (err) {
    logger.warn({ err }, "Sentry shutdown failed");
  }
  initialized = false;
}

/**
 * 明示的にエラーを Sentry に送る。
 * 例外オブジェクトの場合は captureException、文字列なら captureMessage。
 */
export function captureError(
  err: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!initialized) return;
  if (err instanceof Error) {
    Sentry.captureException(err, context);
  } else {
    Sentry.captureMessage(String(err), { level: "error", ...context });
  }
}
