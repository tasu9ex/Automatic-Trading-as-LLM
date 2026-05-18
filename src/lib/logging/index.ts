import pino, { type Logger as PinoLogger } from "pino";

/**
 * Namespace 付きロガー。
 * 開発時は pino-pretty で human-readable、本番は JSON で構造化ログ。
 *
 * Usage:
 *   const logger = createLogger("cycle.judgment");
 *   logger.info({ symbol: "BTC" }, "Pipeline started");
 *   logger.error(err, "Failed step");
 */

const isDev = process.env.NODE_ENV !== "production";
const isVitest = process.env.VITEST === "true";
// Next.js (Turbopack / webpack) のバンドラ内では pino-pretty の worker_thread が壊れるので無効化。
// CLI 実行 (tsx) のときだけ pretty 出力。
const isNextBundled = typeof process.env.NEXT_RUNTIME !== "undefined";
const usePretty = isDev && !isVitest && !isNextBundled;

const root = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: usePretty
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      }
    : undefined,
});

export interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export type Logger = PinoLogger;

const cache = new Map<string, Logger>();

export function createLogger(namespace: string, ctx?: LogContext): Logger {
  const key = ctx ? `${namespace}:${JSON.stringify(ctx)}` : namespace;
  const cached = cache.get(key);
  if (cached) return cached;
  const logger = root.child({ ns: namespace, ...ctx });
  cache.set(key, logger);
  return logger;
}
