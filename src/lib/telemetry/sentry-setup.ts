import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import * as Sentry from "@sentry/node";

const logger = createLogger("telemetry.sentry-setup");

let initialized = false;

/**
 * Sentry の event から Discord 通知用のサマリを抽出。
 * stack trace 詳細は Sentry に保管、Discord には先頭情報 + event_id のみ。
 */
function summarizeForDiscord(event: Sentry.ErrorEvent): { title: string; body: string } {
  const exception = event.exception?.values?.[0];
  const message = exception?.value ?? event.message ?? "Unknown Sentry error";
  const type = exception?.type ?? null;
  const eventId = event.event_id?.slice(0, 8) ?? "-";
  const tags = event.tags ? Object.entries(event.tags).slice(0, 6) : [];

  const lines = [
    type ? `\`${type}\` ${message}` : message,
    "",
    ...tags.map(([k, v]) => `\`${k}\`: ${String(v)}`),
    "",
    `event_id: \`${eventId}\` (Sentry でフル詳細確認)`,
  ];
  return {
    title: `❌ ${message.slice(0, 120)}`,
    body: lines.join("\n").slice(0, 1900),
  };
}

/**
 * Sentry Node SDK 初期化 (CLI / Inngest ワーカー用)。
 *
 * 必要 env:
 *   NEXT_PUBLIC_SENTRY_DSN
 *
 * 未設定なら no-op。
 *
 * Discord 連携は beforeSend フックで自前実装(Sentry Team プラン $26/月 を回避):
 *   Sentry に転送される全エラー → notify({ level: "error" }) → Discord errors channel
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
    beforeSend(event) {
      // Discord に非同期で転送(failure は無視)。Sentry には引き続き送る。
      const { title, body } = summarizeForDiscord(event);
      const level = event.level === "fatal" ? "critical" : "error";
      notify({ level, title, body }).catch((err) => {
        logger.warn({ err }, "Failed to forward Sentry event to Discord");
      });
      return event;
    },
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
 * beforeSend フックが Discord 転送も自動でやる。
 */
export function captureError(
  err: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!initialized) {
    // Sentry 未初期化なら直接 Discord に通知(フォールバック)
    const message = err instanceof Error ? err.message : String(err);
    notify({
      level: "error",
      title: `❌ ${message.slice(0, 120)}`,
      body: err instanceof Error ? `\`\`\`${err.stack?.slice(0, 1500)}\`\`\`` : undefined,
      ...(context?.tags ? { fields: context.tags } : {}),
    }).catch((notifyErr) => {
      logger.warn({ err: notifyErr }, "Fallback Discord notify failed");
    });
    return;
  }
  if (err instanceof Error) {
    Sentry.captureException(err, context);
  } else {
    Sentry.captureMessage(String(err), { level: "error", ...context });
  }
}
