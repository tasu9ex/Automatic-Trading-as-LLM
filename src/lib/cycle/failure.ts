/**
 * サイクル失敗時の処理。
 *
 * - state 更新 (consecutiveFailures / lastFailureKind / quota は即 paused)
 * - system_events 記録 (phase 別に kind を出し分け §22)
 * - kill-switch チェック (連続失敗閾値で auto-pause、§18)
 * - Discord 通知 (transient / permanent / quota の 3 フォーマット §A、auto-pause 発動状態を反映)
 *
 * phases.ts から分離 (§15 split)。
 */

import { db } from "@/db/client";
import { cycles, systemEvents, systemState } from "@/db/schema";
import { type ErrorKind, classifyError } from "@/lib/cycle/retry";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { getRiskParams } from "@/lib/risk/params";
import { advanceNextScheduledAt } from "@/lib/system-control";
import { eq } from "drizzle-orm";

const logger = createLogger("cycle.failure");

/** Phase 名から推定原因 + 推奨対応 (transient 用ヒント) */
const PHASE_HINTS: Record<string, { cause: string; action: string }> = {
  "tier0-snapshots": {
    cause: "Perplexity / Grok / GMO API の一時障害",
    action: "API status 確認後、次サイクル待ち",
  },
  "tier1-pre-analyst": {
    cause: "Anthropic 過負荷 (overloaded_error) の可能性",
    action: "https://status.anthropic.com 確認、次サイクル待ち",
  },
  "tier2-analyst": {
    cause: "Anthropic Opus 過負荷 or ITPM レート超過",
    action: "Langfuse で詳細確認、次サイクル待ち",
  },
  "tier3-decisions": {
    cause: "Anthropic Sonnet 過負荷 or ITPM レート超過",
    action: "Langfuse で詳細確認、次サイクル待ち",
  },
  finalize: {
    cause: "Critic 失敗 / DB 接続 / Executor バグ",
    action: "ログとダッシュボード状態を確認",
  },
};

/** サイクル中断時の通知 + 連続失敗カウント更新 (エラー種別ごとに対応分岐) */
export async function recordCycleFailure(args: {
  cycleId: string;
  strategyId: string;
  phase: string;
  err: unknown;
}): Promise<void> {
  const errMsg = args.err instanceof Error ? args.err.message : String(args.err);
  const kind = classifyError(args.err);
  logger.error({ cycleId: args.cycleId, phase: args.phase, kind, err: args.err }, "Cycle aborted");

  const [state, riskParams] = await Promise.all([
    db
      .select()
      .from(systemState)
      .where(eq(systemState.id, "singleton"))
      .limit(1)
      .then((r) => r[0]),
    getRiskParams(),
  ]);

  // quota: 即 system pause (連続失敗カウンタを通さず特別扱い)
  // それ以外: 連続失敗カウンタは "同じ kind が続く間だけ" カウント (異種が来たらリセット)
  const previousKind = state?.lastFailureKind ?? null;
  const previousCount = state?.consecutiveFailures ?? 0;
  let newCount: number;
  if (kind === "quota") {
    newCount = previousCount; // quota は streak の計算に含めない
  } else if (previousKind === kind) {
    newCount = previousCount + 1;
  } else {
    newCount = 1; // 異 kind に切り替わったらリセット
  }
  const nextStateValue = kind === "quota" ? "paused" : (state?.state ?? "running");

  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: nextStateValue,
      consecutiveFailures: newCount,
      lastFailureKind: kind,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        state: nextStateValue,
        consecutiveFailures: newCount,
        lastFailureKind: kind,
        updatedAt: new Date(),
      },
    });

  // §22: phase に応じて enum を出し分け。
  // - tier0-snapshots → data_fetch_failed
  // - tier{1,2,3}-* → llm_failure
  // - finalize / その他 → cycle_aborted
  const eventKind: "data_fetch_failed" | "llm_failure" | "cycle_aborted" =
    args.phase === "tier0-snapshots"
      ? "data_fetch_failed"
      : args.phase.startsWith("tier1") ||
          args.phase.startsWith("tier2") ||
          args.phase.startsWith("tier3")
        ? "llm_failure"
        : "cycle_aborted";
  await db.insert(systemEvents).values({
    strategyId: args.strategyId,
    kind: eventKind,
    severity: "error",
    message: `Cycle ${args.cycleId.slice(0, 8)} aborted at ${args.phase} (${kind}): ${errMsg.slice(0, 300)}`,
    payload: { cycleId: args.cycleId, phase: args.phase, kind },
    cycleId: args.cycleId,
  });

  // DD: 失敗 cycle も completedAt を埋めて "in_flight" 扱いを終わらせる
  // (dashboard の getRecentCyclesImpl / isCycleInFlight が completedAt IS NULL を見るため)
  await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, args.cycleId));

  if (kind === "quota") {
    await db.insert(systemEvents).values({
      strategyId: args.strategyId,
      kind: "system_paused",
      severity: "warning",
      message: `Auto-paused due to quota / billing error at ${args.phase}`,
      payload: { reason: "quota", phase: args.phase, errMsg: errMsg.slice(0, 300) },
    });
  }

  // 通知の前に kill-switch チェックを走らせ、auto-pause が発動した場合は
  // 通知文面に正確な状態 (now paused) を反映できるようにする (§18)。
  // quota は recordCycleFailure 内で既に paused にしているので追加チェック不要。
  let autoPausedNow = false;
  if (kind !== "quota") {
    const result = await checkAndTriggerKillSwitch({ strategyId: args.strategyId });
    if (result === "paused") autoPausedNow = true;
  }

  // 失敗時も成功時と同じくサイクル間隔バケットを進める。これをやらないと
  // next_scheduled_at が過去のまま残り、毎時 cron が即 due 判定して
  // periodHours を無視した毎時リトライになる。
  // quota / auto-pause 発動時は人手再開なので進めない (再開時に startSystem が再設定)。
  const shouldAdvance = kind !== "quota" && !autoPausedNow;
  const advancedNextScheduledAt = shouldAdvance
    ? await advanceNextScheduledAt(new Date())
    : (state?.nextScheduledAt ?? null);

  await sendFailureNotification({
    kind,
    phase: args.phase,
    cycleId: args.cycleId,
    errMsg,
    newCount,
    nextScheduledAt: advancedNextScheduledAt,
    autoPausedNow,
    autoPauseThreshold: riskParams.autoPauseThreshold,
  });
}

async function sendFailureNotification(args: {
  kind: ErrorKind;
  phase: string;
  cycleId: string;
  errMsg: string;
  newCount: number;
  nextScheduledAt: Date | null;
  /** 本コール時点で auto-pause が既に発動済 (checkAndTriggerKillSwitch が paused を返した) */
  autoPausedNow: boolean;
  /** §17: 動的閾値 (DB 駆動) */
  autoPauseThreshold: number;
}): Promise<void> {
  const cycleShort = args.cycleId.slice(0, 8);
  const nextScheduledAt = args.nextScheduledAt
    ? args.nextScheduledAt.toISOString().slice(0, 16).replace("T", " ")
    : "未設定";

  if (args.kind === "quota") {
    await notify({
      level: "error",
      title: "💸 自動 pause — クォータ切れ",
      body: [
        "**エラー**",
        `\`\`\`\n${args.errMsg.slice(0, 800)}\n\`\`\``,
        "**状態**: system_state = paused (自動)",
        "**推奨**: 残高補充 → ダッシュボード「再開」",
      ].join("\n"),
      fields: {
        サイクル: cycleShort,
        Phase: args.phase,
      },
    });
    return;
  }

  if (args.kind === "permanent") {
    await notify({
      level: "error",
      title: `🐛 サイクル中断 (${args.phase}) — 設定 / コードエラー`,
      body: [
        "**エラー (リトライ不要)**",
        `\`\`\`\n${args.errMsg.slice(0, 800)}\n\`\`\``,
        "**推奨**: 環境変数 / コード修正後にデプロイ → 手動再開",
      ].join("\n"),
      fields: {
        サイクル: cycleShort,
        連続失敗: formatFailureCounter(args.newCount, args.autoPausedNow, args.autoPauseThreshold),
      },
    });
    return;
  }

  // transient (リトライ尽き)
  // 1. error.message から失敗ソースが読み取れればそれを優先 (例: "Tier 0 required sources failed for ETH: 1m kline")
  // 2. 読み取れなければ phase 単位の固定 hint にフォールバック
  const dynamicHint = extractFailureHint(args.errMsg);
  const hint = dynamicHint ??
    PHASE_HINTS[args.phase] ?? {
      cause: "外部 API の一時障害の可能性",
      action: "ログ確認、次サイクル待ち",
    };
  await notify({
    level: "error",
    title: `🌐 サイクル中断 (${args.phase}) — 外部 API 一時障害`,
    body: [
      "**エラー**",
      `\`\`\`\n${args.errMsg.slice(0, 800)}\n\`\`\``,
      `**推定原因**: ${hint.cause}`,
      `**推奨対応**: ${hint.action}`,
    ].join("\n"),
    fields: {
      サイクル: cycleShort,
      連続失敗: formatFailureCounter(args.newCount, args.autoPausedNow, args.autoPauseThreshold),
      次サイクル: nextScheduledAt,
    },
  });
}

/**
 * 連続失敗カウンタの表示文字列。
 *   - 既に auto-pause が発動済 → "3/3 (auto-pause 発動)"
 *   - 閾値到達寸前 (残 0) → "3/3 (次サイクルで auto-pause)" (kill-switch がエラー等で動かなかった保険表記)
 *   - それ以前 → "1/3 (あと 2)"
 * AUTO_PAUSE_THRESHOLD でクランプして 4/3 のような不整合は出さない。
 */
function formatFailureCounter(newCount: number, autoPausedNow: boolean, threshold: number): string {
  const displayCount = Math.min(newCount, threshold);
  const remaining = Math.max(0, threshold - displayCount);
  if (autoPausedNow) return `${displayCount}/${threshold} (auto-pause 発動)`;
  if (remaining === 0) return `${displayCount}/${threshold} (次サイクルで auto-pause)`;
  return `${displayCount}/${threshold} (あと ${remaining})`;
}

/**
 * Tier 0 系のエラーメッセージから失敗ソースを抜き出して、具体的な原因 / 対応を組み立てる。
 *   "Tier 0 required sources failed for ETH: 1m kline" → kline 由来とみなす
 * 抽出できないなら null (呼び元が PHASE_HINTS にフォールバック)
 */
function extractFailureHint(errMsg: string): { cause: string; action: string } | null {
  // "Tier 0 required sources failed for <SYMBOL>: <SOURCE1>, <SOURCE2> (<reason details>...)" を捕捉
  // 後ろの "(<reason ...>)" は cause 抽出には使わないので、最初の "(" 直前までを source 列として読む。
  const m = errMsg.match(/Tier 0 required sources failed for (\w+):\s*([^(\n]+)/i);
  if (!m) return null;
  const symbol = m[1];
  const sources = (m[2] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sources.length === 0) return null;

  const causeBySource: Record<string, string> = {
    "1m kline": "GMO の 1m kline がデータ未公開 (早朝など date が変わった直後に発生しやすい)",
    "1d kline": "GMO の 1d kline 取得失敗",
    "1hour kline": "GMO の 1h kline 取得失敗",
    "4hour kline": "GMO の 4h kline 取得失敗",
    "1day kline": "GMO の 1day kline 取得失敗",
    Ticker: "GMO Ticker API の障害",
    Perplexity: "Perplexity API の障害 (status 確認: https://status.perplexity.ai)",
    Grok: "xAI Grok API の障害 (status 確認: https://status.x.ai)",
  };
  const causes = sources.map((s) => causeBySource[s] ?? `${s} 取得失敗`);
  return {
    cause: `${symbol}: ${causes.join(" / ")}`,
    action: "次サイクルで自動リトライ。連発するなら API status と periodHours 設定を確認",
  };
}
