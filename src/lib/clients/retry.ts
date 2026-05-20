/**
 * クライアント単体の軽量リトライ。
 *
 * 用途: 単一 HTTP endpoint への transient flake を吸収する。
 * 上位 withRetry (cycle/retry.ts) が拾うより前にここで処理しておけば、
 * fetchSnapshot 内の他並列 fetch を巻き込んで再実行せずに済む。
 */

import { classifyError } from "@/lib/cycle/retry";
import { createLogger } from "@/lib/logging";

const logger = createLogger("clients.retry");

export interface ClientRetryOptions {
  label: string;
  /** 試行回数 (default 2 = 初回 + 1 retry) */
  maxAttempts?: number;
  /** 1 回目失敗後の待機 ms (default 500) */
  baseDelayMs?: number;
}

export async function withClientRetry<T>(
  fn: () => Promise<T>,
  opts: ClientRetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelay = opts.baseDelayMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind !== "transient" || attempt >= maxAttempts) {
        // permanent / quota → 即 throw / 最終 attempt → throw
        if (kind !== "transient") {
          logger.error({ label: opts.label, kind, err }, "Client fast-fail");
        }
        throw err;
      }
      const delay = baseDelay * 2 ** (attempt - 1);
      logger.warn(
        { label: opts.label, attempt, maxAttempts, delayMs: delay, err },
        "Client retry after transient flake",
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
