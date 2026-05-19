/**
 * Langfuse からサイクル単位のコスト集計を取得。
 *
 * サイクル開始時に span.setAttribute("langfuse.session.id", cycleId) で
 * trace を session 紐付けしているため、sessionId で query 可能。
 *
 * eventual consistency: span flush 後すぐに fetch しても trace が
 * 取得できない場合がある。呼び出し側で 10-15s 待ってから呼ぶ。
 */

import { createLogger } from "@/lib/logging";
import { LangfuseClient } from "@langfuse/client";

const logger = createLogger("telemetry.fetch-cycle-cost");

export interface CycleCostSummary {
  cycleId: string;
  traceCount: number;
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

  try {
    const tracesRes = await client.api.trace.list({ sessionId: cycleId });
    const traces = tracesRes.data ?? [];

    let totalCostUsd = 0;
    const observationsByModel: Record<string, { count: number; costUsd: number }> = {};

    for (const trace of traces) {
      const id = trace.id;
      if (!id) continue;
      const detail = await client.api.trace.get(id);
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
      totalCostUsd,
      totalCostJpy: totalCostUsd * USD_TO_JPY,
      observationsByModel,
    };
  } catch (err) {
    logger.warn({ err, cycleId }, "fetchCycleCost failed");
    return null;
  }
}
