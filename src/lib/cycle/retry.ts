/**
 * Per-coin リトライヘルパー + エラー分類。
 *
 * 各 Tier ステップで個別コインに対する API 呼び出しを exp backoff で N 回リトライ。
 * 全リトライ失敗で throw → 上位 Promise.all で集約 → step 全体失敗扱い。
 *
 * 設計判断:
 *   - ALL-or-NOTHING: 1 コインでも完走しなければサイクル全体 abort
 *   - Fast-fail: 永続エラー (env / 401/403/400 / quota) は retry せず即 throw
 *   - Retry 対象は transient (5xx / 429 / timeout / network) のみ
 */

import { createLogger } from "@/lib/logging";

const logger = createLogger("cycle.retry");

export type ErrorKind = "transient" | "permanent" | "quota";

/**
 * Error message からエラー種別を判定。
 *
 *   - quota:     残高切れ / billing 制限 / クレジット不足 → system pause 推奨
 *   - permanent: 401 / 403 / 400 / 422 / 404 / env 未設定 → コード/設定修正必須、retry 無意味
 *   - transient: 上記以外 (5xx / 429 / timeout / network / overloaded) → retry で回復見込み
 */
export function classifyError(err: unknown): ErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Quota / billing: 即 pause 推奨
  if (
    /insufficient[_ ]?quota|credit balance|billing[_ ]?hard[_ ]?limit|hard_limit|payment[_ ]?required|\b402\b|exceeded.*quota|quota.*exceeded|out of credits|no credits/.test(
      msg,
    )
  ) {
    return "quota";
  }

  // Env / 認証 / リクエスト不正: コード or 設定を直さない限り永久失敗
  if (
    /(api[_ -]?key|x-api-key|authorization).*(not set|missing|required|invalid|empty)/.test(msg) ||
    /(missing|required|invalid|no|empty).*(api[_ -]?key|x-api-key|authorization|bearer)/.test(
      msg,
    ) ||
    /\bx-api-key\b/.test(msg) ||
    /invalid_api_key|invalid_authorization|invalid_credentials|incorrect_api_key/.test(msg)
  ) {
    return "permanent";
  }
  if (/unauthorized|forbidden|authentication|\b401\b|\b403\b/.test(msg)) {
    return "permanent";
  }
  if (/\b400\b|\b404\b|\b422\b|invalid_request|bad request|not found/.test(msg)) {
    return "permanent";
  }

  // それ以外 (5xx, 429, timeout, ECONNRESET, overloaded, rate_limit_exceeded) は transient
  return "transient";
}

export interface RetryOptions {
  maxAttempts?: number;
  /** 1 回目失敗後の待機 ms。指数で 2 倍ずつ伸びる (1000 → 2000 → 4000) */
  baseDelayMs?: number;
  /** ログ用ラベル (例: "tier0:BTC") */
  label: string;
}

/**
 * transient エラーのみリトライ。permanent / quota は即 throw (fast-fail)。
 *
 * 永続エラーで同じ API を maxAttempts 回叩く無駄を排除。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  // クライアント単体で 1 retry / Inngest step も 1 retry するので、ここは控えめに 2 (init + 1)
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      // 永続エラーは retry しても無駄 — 即 bubble up
      if (kind !== "transient") {
        logger.error(
          { label: opts.label, attempt, kind, err },
          `Fast-fail (${kind} error, no retry)`,
        );
        throw err;
      }

      // transient: 残り attempt があれば待ってリトライ
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        logger.warn(
          { label: opts.label, attempt, maxAttempts, delayMs: delay, err },
          "Retry after transient failure",
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logger.error({ label: opts.label, attempt, err }, "All retries exhausted");
      }
    }
  }
  throw lastErr;
}
