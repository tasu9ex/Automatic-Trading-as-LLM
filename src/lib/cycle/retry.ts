/**
 * Per-coin リトライヘルパー。
 *
 * 各 Tier ステップで個別コインに対する API 呼び出しを exp backoff で N 回リトライ。
 * 全リトライ失敗で throw → 上位 Promise.all で集約 → step 全体失敗扱い。
 *
 * 設計判断: ALL-or-NOTHING ポリシー (1 コインでも完走しなければサイクル全体 abort)
 */

import { createLogger } from "@/lib/logging";

const logger = createLogger("cycle.retry");

export interface RetryOptions {
  maxAttempts?: number;
  /** 1 回目失敗後の待機 ms。指数で 2 倍ずつ伸びる (1000 → 2000 → 4000) */
  baseDelayMs?: number;
  /** ログ用ラベル (例: "tier0:BTC") */
  label: string;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        logger.warn(
          { label: opts.label, attempt, maxAttempts, delayMs: delay, err },
          "Retry after failure",
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logger.error({ label: opts.label, attempt, err }, "All retries exhausted");
      }
    }
  }
  throw lastErr;
}
