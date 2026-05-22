/**
 * Langfuse trace の中身を詳細表示して cost=0 の原因を切り分ける。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.prod scripts/dev/inspect-langfuse-cost.ts <cycleId>
 *   pnpm tsx --env-file=.env.prod scripts/dev/inspect-langfuse-cost.ts    # 直近サイクル自動取得
 *
 * 確認内容:
 *   - sessionId で trace 一覧が引けるか
 *   - 各 observation の model / inputUsage / outputUsage / calculatedTotalCost
 *   - model が pricing 登録名と一致しているか
 */

import { db } from "@/db/client";
import { cycles } from "@/db/schema";
import { LangfuseClient } from "@langfuse/client";
import { desc } from "drizzle-orm";

async function getLatestCycleId(): Promise<string> {
  const row = (await db.select().from(cycles).orderBy(desc(cycles.startedAt)).limit(1))[0];
  if (!row) throw new Error("No cycles found in DB");
  return row.id;
}

async function main() {
  const cycleIdArg = process.argv[2];
  const cycleId = cycleIdArg ?? (await getLatestCycleId());

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) throw new Error("LANGFUSE_* keys missing");

  const client = new LangfuseClient({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  console.log(`\n=== Langfuse cost inspection for cycle ${cycleId} ===\n`);

  const tracesRes = await client.api.trace.list({ sessionId: cycleId });
  const traces = tracesRes.data ?? [];
  console.log(`traces in session: ${traces.length}`);

  if (traces.length === 0) {
    console.log(
      "  (no traces with this sessionId — fallback: list 5 most recent traces in project)\n",
    );
    const recent = await client.api.trace.list({ limit: 5 });
    for (const t of recent.data ?? []) {
      console.log(
        `  trace ${(t.id ?? "").slice(0, 12)}  sessionId=${t.sessionId ?? "(none)"}  name=${t.name ?? "?"}  cost=$${(t.totalCost ?? 0).toFixed(6)}  timestamp=${t.timestamp ?? ""}`,
      );
    }
    console.log(
      "\n→ session id が trace に紐付いていない可能性。AI SDK の metadata.sessionId が LangfuseSpanProcessor に認識されていない",
    );
    process.exit(0);
  }

  let grandTotalCostUsd = 0;
  let obsWithModel = 0;
  let obsWithoutModel = 0;
  let obsWithUsage = 0;
  let obsWithoutUsage = 0;
  const modelCounts: Record<string, { count: number; cost: number; tokens: number }> = {};

  for (const trace of traces) {
    if (!trace.id) continue;
    const detail = await client.api.trace.get(trace.id);
    const traceCost = detail.totalCost ?? 0;
    grandTotalCostUsd += traceCost;
    console.log(`\n── trace ${trace.id.slice(0, 12)} (name=${detail.name ?? "?"})`);
    console.log(
      `   totalCost=$${traceCost.toFixed(6)}  observations=${detail.observations?.length ?? 0}`,
    );

    for (const obs of detail.observations ?? []) {
      const model = obs.model ?? null;
      const inTok =
        // biome-ignore lint/suspicious/noExplicitAny: Langfuse API shape varies
        (obs as any).usage?.input ?? (obs as any).usage?.inputTokens ?? null;
      const outTok =
        // biome-ignore lint/suspicious/noExplicitAny: Langfuse API shape varies
        (obs as any).usage?.output ?? (obs as any).usage?.outputTokens ?? null;
      const cost = obs.calculatedTotalCost ?? 0;
      if (model) obsWithModel++;
      else obsWithoutModel++;
      if (inTok != null || outTok != null) obsWithUsage++;
      else obsWithoutUsage++;

      if (model) {
        if (!modelCounts[model]) modelCounts[model] = { count: 0, cost: 0, tokens: 0 };
        modelCounts[model].count++;
        modelCounts[model].cost += cost;
        modelCounts[model].tokens += (inTok ?? 0) + (outTok ?? 0);
      }

      console.log(
        `     [${obs.type ?? "?"}] model=${model ?? "(none)"}  in=${inTok ?? "-"}  out=${outTok ?? "-"}  cost=$${cost.toFixed(6)}`,
      );
    }
  }

  console.log("\n=== Summary ===");
  console.log(`total cost (USD):       $${grandTotalCostUsd.toFixed(6)}`);
  console.log(`observations w/ model:  ${obsWithModel}`);
  console.log(`observations w/o model: ${obsWithoutModel}  ← これが多いと pricing match できない`);
  console.log(`observations w/ usage:  ${obsWithUsage}`);
  console.log(`observations w/o usage: ${obsWithoutUsage}  ← これが多いと cost = 0 になる`);
  if (Object.keys(modelCounts).length > 0) {
    console.log("\n--- per model ---");
    for (const [m, v] of Object.entries(modelCounts)) {
      console.log(
        `  ${m.padEnd(40)}  obs=${v.count}  tokens=${v.tokens}  cost=$${v.cost.toFixed(6)}`,
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
