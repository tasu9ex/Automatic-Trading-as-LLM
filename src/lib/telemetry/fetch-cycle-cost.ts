/**
 * Langfuse からサイクル単位のコスト集計を取得。
 *
 * サイクル開始時に span.setAttribute("langfuse.session.id", cycleId) で
 * trace を session 紐付けしているため、sessionId で query 可能。
 *
 * eventual consistency: span flush 後すぐに fetch しても trace が
 * 取得できない場合がある。呼び出し側で 10-15s 待ってから呼ぶ。
 *
 * 一過性障害への耐性:
 *   - Langfuse Cloud は 502/503/429 を散発的に返す。`withRetry` で transient のみ
 *     exp backoff リトライし、瞬間的な不調を吸収する。
 *   - trace.get はトレース単位でリトライし、リトライ尽きても *そのトレースだけ* skip
 *     して集計を続行 (オール・オア・ナッシングを避ける)。skip 件数は failedTraceCount
 *     で返し、呼び出し側が「部分計上」と明示できるようにする。
 *   - trace.list (一覧取得) だけは失敗すると何も集計できないので、リトライ尽きたら null。
 */

import { withRetry } from "@/lib/cycle/retry";
import { createLogger } from "@/lib/logging";
import { LangfuseClient } from "@langfuse/client";

const logger = createLogger("telemetry.fetch-cycle-cost");

export interface CycleCostSummary {
  cycleId: string;
  traceCount: number;
  /** trace.get がリトライ後も取得できず集計から除外したトレース数 (0 なら完全集計)。 */
  failedTraceCount: number;
  totalCostUsd: number;
  totalCostJpy: number;
  observationsByModel: Record<string, { count: number; costUsd: number }>;
}

const USD_TO_JPY = 150;

export async function fetchCycleCost(cycleId: string): Promise<CycleCostSummary | null> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    logger.warn("Langfuse keys not set, skip cost fetch");
    return null;
  }

  const client = new LangfuseClient({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  // 一覧取得は集計の前提。リトライ尽きたら何も集計できないので null。
  let traces: Awaited<ReturnType<typeof client.api.trace.list>>["data"];
  try {
    const tracesRes = await withRetry(() => client.api.trace.list({ sessionId: cycleId }), {
      label: `langfuse:trace.list:${cycleId.slice(0, 8)}`,
      maxAttempts: 4,
      baseDelayMs: 1000,
    });
    traces = tracesRes.data ?? [];
  } catch (err) {
    logger.warn({ err, cycleId }, "fetchCycleCost: trace.list failed after retries");
    return null;
  }

  let totalCostUsd = 0;
  let failedTraceCount = 0;
  const observationsByModel: Record<string, { count: number; costUsd: number }> = {};

  for (const trace of traces) {
    const id = trace.id;
    if (!id) continue;
    let detail: Awaited<ReturnType<typeof client.api.trace.get>>;
    try {
      detail = await withRetry(() => client.api.trace.get(id), {
        label: `langfuse:trace.get:${id.slice(0, 8)}`,
        maxAttempts: 4,
        baseDelayMs: 1000,
      });
    } catch (err) {
      // 個別トレースの取得失敗は致命化しない。skip して残りを集計し続ける。
      failedTraceCount += 1;
      logger.warn(
        { err, cycleId, traceId: id },
        "fetchCycleCost: trace.get failed, skipping trace",
      );
      continue;
    }
    totalCostUsd += detail.totalCost ?? 0;
    for (const obs of detail.observations ?? []) {
      // model 名なし = AI SDK の親 wrapper span (子に generation span が別途ある) → スキップ
      if (!obs.model) continue;
      const modelName = obs.model;
      if (!observationsByModel[modelName]) {
        observationsByModel[modelName] = { count: 0, costUsd: 0 };
      }
      observationsByModel[modelName].count += 1;
      observationsByModel[modelName].costUsd += obs.calculatedTotalCost ?? 0;
    }
  }

  return {
    cycleId,
    traceCount: traces.length,
    failedTraceCount,
    totalCostUsd,
    totalCostJpy: totalCostUsd * USD_TO_JPY,
    observationsByModel,
  };
}
