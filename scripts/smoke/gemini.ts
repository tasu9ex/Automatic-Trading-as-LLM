import { generateJson } from "@/lib/clients/generate-json";
import { z } from "zod";

async function main() {
  console.log("=== Gemini Smoke Test ===\n");

  const result = await generateJson({
    modelId: "gemini-2.5-flash",
    system: "You are a helpful assistant. Always respond in Japanese.",
    prompt: "BTCの現在の市場環境を一言で表してください。",
    schema: z.object({
      summary: z.string().describe("市場環境の一言要約"),
      sentiment: z.enum(["bullish", "neutral", "bearish"]),
    }),
    feature: "smoke/gemini",
  });

  console.log(`[summary]   ${result.summary}`);
  console.log(`[sentiment] ${result.sentiment}`);
  console.log("\n✓ Gemini API — OK");
}

main().catch((err) => {
  console.error("Gemini smoke test FAILED:", err);
  process.exit(1);
});
