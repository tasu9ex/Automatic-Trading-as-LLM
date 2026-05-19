import { callGrok } from "@/lib/clients/grok";

async function main() {
  console.log("=== Grok Smoke Test ===\n");

  const res = await callGrok({
    userPrompt: "BTC の過去 24 時間の X (Twitter) センチメントを 100 字で要約してください。",
    maxTokens: 300,
  });

  console.log(`[content] ${res.content.slice(0, 300)}`);
  console.log(`[tokens]  input=${res.usage.inputTokens} output=${res.usage.outputTokens}`);
  console.log("\n✓ Grok API — OK");
}

main().catch((err) => {
  console.error("Grok smoke test FAILED:", err);
  process.exit(1);
});
