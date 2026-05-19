import { callPerplexity } from "@/lib/clients/perplexity";

async function main() {
  console.log("=== Perplexity Smoke Test ===\n");

  const res = await callPerplexity({
    model: "sonar",
    systemPrompt: "あなたは仮想通貨ニュースのアナリストです。簡潔に要約してください。",
    userPrompt:
      "BTC (ビットコイン) の過去 24 時間のニュース・規制動向を 200 字以内で要約。引用元 URL を含めて。",
    maxTokens: 500,
  });

  console.log(`[content]   ${res.content.slice(0, 400)}`);
  console.log(`[citations] ${res.citations?.length ?? 0} 件`);
  if (res.citations && res.citations.length > 0) {
    for (const url of res.citations.slice(0, 5)) console.log(`  - ${url}`);
  }
  console.log(`[tokens]    input=${res.usage.inputTokens} output=${res.usage.outputTokens}`);

  console.log("\n✓ Perplexity API — OK");
}

main().catch((err) => {
  console.error("Perplexity smoke test FAILED:", err);
  process.exit(1);
});
