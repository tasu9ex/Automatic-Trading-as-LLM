import { generateJson } from "@/lib/clients/generate-json";
import { z } from "zod";

async function main() {
  console.log("=== Anthropic Smoke Test ===\n");

  console.log("[1/2] claude-haiku-4-5 (Tier 1 想定)");
  const haiku = await generateJson({
    modelId: "claude-haiku-4-5",
    system: "You are a helpful assistant. Always respond in Japanese.",
    prompt: "BTC の現在の市場環境を一言で表してください。",
    schema: z.object({
      summary: z.string(),
      sentiment: z.enum(["bullish", "neutral", "bearish"]),
    }),
    feature: "smoke/anthropic-haiku",
  });
  console.log(`  summary:   ${haiku.summary}`);
  console.log(`  sentiment: ${haiku.sentiment}\n`);

  console.log("[2/2] claude-opus-4-7 (Tier 2 想定)");
  const opus = await generateJson({
    modelId: "claude-opus-4-7",
    system: "You are a senior crypto market analyst. Respond in Japanese.",
    prompt: "BTC の長期見通しを 1 文で。",
    schema: z.object({
      view: z.string(),
      confidence: z.number().min(0).max(1),
    }),
    feature: "smoke/anthropic-opus",
  });
  console.log(`  view:       ${opus.view}`);
  console.log(`  confidence: ${opus.confidence}`);

  console.log("\n✓ Anthropic API — OK (Haiku + Opus)");
}

main().catch((err) => {
  console.error("Anthropic smoke test FAILED:", err);
  process.exit(1);
});
