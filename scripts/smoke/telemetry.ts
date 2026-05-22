/**
 * Sentry+Langfuse 共存セットアップの end-to-end smoke。
 *
 * 流れ:
 *   1. initSentry() → setupOtelWithSentry (AlwaysOnSampler + SentrySpanProcessor + LangfuseSpanProcessor)
 *   2. runWithSession で sessionId をセット
 *   3. generateJson で Anthropic Haiku を 1 回叩く (AI SDK telemetry が span を出す)
 *   4. shutdownSentry() で flush
 *   5. 15s 待って Langfuse から sessionId 紐付け trace を取得 → 結果出力
 *
 * Usage:
 *   pnpm smoke:local:telemetry
 *   pnpm smoke:prod:telemetry
 */

import { randomUUID } from "node:crypto";
import { initSentry, runWithSession, shutdownSentry } from "@/lib/telemetry";
import { LangfuseClient } from "@langfuse/client";
import { z } from "zod";

async function main() {
  const sessionId = randomUUID();
  console.log("=== Telemetry Smoke ===\n");
  console.log(`sessionId: ${sessionId}\n`);

  console.log("[1/5] initSentry()");
  initSentry();

  // Sentry 初期化後に AI SDK 周辺を dynamic import
  const { generateJson } = await import("@/lib/clients/generate-json");

  console.log("[2/5] runWithSession + generateJson (Haiku)");
  await runWithSession(sessionId, async () => {
    const out = await generateJson({
      modelId: "claude-haiku-4-5",
      system: "Respond in Japanese.",
      prompt: "BTC とは何か 1 行で。",
      schema: z.object({ summary: z.string() }),
      feature: "smoke.telemetry",
    });
    console.log(`  -> ${out.summary.slice(0, 60)}...`);
  });

  console.log("[3/5] shutdownSentry()");
  await shutdownSentry();

  console.log("[4/5] sleep 15s (Langfuse ingestion delay)");
  await new Promise((r) => setTimeout(r, 15_000));

  console.log("[5/5] Langfuse から sessionId 紐付け trace を取得");
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  const res = await client.api.trace.list({ sessionId });
  const traces = res.data ?? [];
  console.log(`  traces found: ${traces.length}`);
  for (const t of traces) {
    console.log(
      `    ${(t.id ?? "").slice(0, 12)}  name=${t.name ?? "?"}  cost=$${(t.totalCost ?? 0).toFixed(6)}`,
    );
  }

  if (traces.length === 0) {
    console.log(
      "\n✗ FAIL: telemetry pipeline broken — span never reached Langfuse (auth / setup / shutdown timing いずれか)",
    );
    process.exit(1);
  }
  console.log("\n✓ OK: telemetry pipeline works end-to-end");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke:telemetry FAILED:", err);
  process.exit(1);
});
