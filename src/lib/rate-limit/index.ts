import { createLogger } from "@/lib/logging";
import PQueue from "p-queue";

/**
 * 外部 API レート制限。
 *
 * Phase 5c で複数モデル並走時に Anthropic/Perplexity/Grok のレート上限を
 * 突破しないよう、サービスごとに並列度を絞る。
 *
 * Usage:
 *   import { runWith } from "@/lib/rate-limit";
 *   const result = await runWith("anthropic", () => callAnthropic(...));
 *
 * MVP 値:
 *   anthropic: 5 並列 / 600 req per minute (Tier 1 想定)
 *   perplexity: 3 並列
 *   grok: 3 並列
 *   gmo: 1 並列 / 1 req per 100ms (公式制限あり)
 */

const logger = createLogger("rate-limit");

export type ServiceName = "anthropic" | "google" | "perplexity" | "grok" | "gmo";

interface QueueConfig {
  concurrency: number;
  intervalCap?: number;
  interval?: number;
}

const CONFIGS: Record<ServiceName, QueueConfig> = {
  anthropic: { concurrency: 5, intervalCap: 600, interval: 60_000 },
  google: { concurrency: 5, intervalCap: 60, interval: 60_000 }, // Free tier 1500/day, 安全側で 60/min
  perplexity: { concurrency: 3, intervalCap: 50, interval: 60_000 },
  grok: { concurrency: 3, intervalCap: 60, interval: 60_000 },
  gmo: { concurrency: 1, intervalCap: 10, interval: 1_000 },
};

const queues = new Map<ServiceName, PQueue>();

function getQueue(service: ServiceName): PQueue {
  const cached = queues.get(service);
  if (cached) return cached;
  const q = new PQueue(CONFIGS[service]);
  queues.set(service, q);
  return q;
}

export async function runWith<T>(service: ServiceName, task: () => Promise<T>): Promise<T> {
  const q = getQueue(service);
  if (q.size > 50) {
    logger.warn({ service, queueSize: q.size }, "Rate limit queue depth high");
  }
  return q.add(task) as Promise<T>;
}

export function getQueueStats(service: ServiceName) {
  const q = getQueue(service);
  return {
    size: q.size,
    pending: q.pending,
    concurrency: q.concurrency,
  };
}

/** テスト用: 全 queue をクリア */
export function clearAllQueues(): void {
  for (const q of queues.values()) {
    q.clear();
  }
  queues.clear();
}
