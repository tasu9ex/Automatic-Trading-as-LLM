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
 *
 * II: HTTP status は err の属性 (err.status / err.response.status) を最優先で見る。
 * 文字列マッチは fallback。`\b400\b` の正規表現で `400000ms timeout` を 400 誤検出していた、
 * LLM プロバイダのエラーフォーマット変更で全分類が壊れる、といった脆さを避ける。
 */
export function classifyError(err: unknown): ErrorKind {
  // 複数ソース集約エラー (Tier 0 必須ソース失敗) は各ソースを個別分類して合成する。
  // message を 1 本に連結した文字列を素朴に regex マッチすると、1 ソースの "404" 等で
  // 全体が permanent に化け、GMO メンテ (transient) と同居したときに誤って 🐛 通知 +
  // kill-switch カウントを進めてしまう。
  const aggregate = classifyAggregate(err);
  if (aggregate !== null) return aggregate;

  const status = extractHttpStatus(err);
  if (status !== null) {
    if (status === 402) return "quota";
    if (status === 401 || status === 403 || status === 400 || status === 404 || status === 422) {
      return "permanent";
    }
    // 5xx / 429 は transient。下の文字列マッチに任せず即 transient で返す
    // (文字列に "401" を含む 5xx メッセージ等の誤判定回避)。
    if (status >= 500 || status === 429) return "transient";
  }

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Quota / billing: 即 pause 推奨
  if (
    /insufficient[_ ]?quota|credit balance|billing[_ ]?hard[_ ]?limit|hard_limit|payment[_ ]?required|\b402\b|exceeded.*quota|quota.*exceeded|out of credits|no credits/.test(
      msg,
    )
  ) {
    return "quota";
  }

  // 取引所メンテ (GMO status:5 / ERR-5201) は時間が経てば回復する transient。
  // permanent 判定より前に確定させ、body に紛れた数字トークンでの誤分類を防ぐ。
  if (/\bmaintenance\b|err-5201/.test(msg)) {
    return "transient";
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

/**
 * RequiredSourcesFailedError (Tier 0 必須ソース失敗) を構造的に分類。
 *
 * `failures[].reasonMessage` を 1 つずつ classifyError し、回復可能性の高い順に合成:
 *   - quota が 1 つでもあれば quota     (billing 対応が必要 → pause が最も安全)
 *   - transient が 1 つでもあれば transient (retry / 次サイクルで回復見込み → 🐛 通知を出さない)
 *   - それ以外 (全て permanent) のみ permanent
 *
 * transient を permanent より優先するのは意図的。GMO メンテ (transient) と他ソースの
 * 一過性 4xx が同居したときに false の permanent 警報を出さないため。真に永続的な障害なら、
 * メンテ明け後のサイクルで transient ソースが消え、permanent として正しく再分類される。
 *
 * import 循環を避けるため fetch-snapshot の class を import せずダックタイピングで判定。
 * 対象外の err なら null を返し、呼び出し側は通常分類にフォールバックする。
 */
function classifyAggregate(err: unknown): ErrorKind | null {
  if (typeof err !== "object" || err === null) return null;
  if ((err as { name?: unknown }).name !== "RequiredSourcesFailedError") return null;
  const failures = (err as { failures?: unknown }).failures;
  if (!Array.isArray(failures)) return null;
  const reasons = failures
    .map((f) => (f as { reasonMessage?: unknown }).reasonMessage)
    .filter((r): r is string => typeof r === "string");
  if (reasons.length === 0) return null;

  const kinds = reasons.map((r) => classifyError(r));
  if (kinds.includes("quota")) return "quota";
  if (kinds.includes("transient")) return "transient";
  return "permanent";
}

/**
 * err の属性から HTTP status を取り出す。SDK ごとに位置が違うのを吸収:
 *   - Anthropic SDK / OpenAI SDK: err.status
 *   - fetch wrapper / axios: err.response?.status
 *   - 自作 wrapper: err.statusCode
 * 数字でない / 範囲外 (< 100 || >= 600) は null。
 */
function extractHttpStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const candidates: unknown[] = [
    (err as { status?: unknown }).status,
    (err as { statusCode?: unknown }).statusCode,
    (err as { response?: { status?: unknown } }).response?.status,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 100 && c < 600) {
      return c;
    }
  }
  return null;
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
