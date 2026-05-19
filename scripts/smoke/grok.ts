import { callGrok } from "@/lib/clients/grok";

async function main() {
  console.log("=== Grok Smoke Test ===\n");

  console.log("[1/2] /v1/chat/completions (no tools)");
  const chat = await callGrok({
    userPrompt: "BTC の過去 24 時間の X (Twitter) センチメントを 100 字で要約してください。",
    maxTokens: 300,
  });
  console.log(`  content: ${chat.content.slice(0, 200)}`);
  console.log(`  tokens:  input=${chat.usage.inputTokens} output=${chat.usage.outputTokens}\n`);

  console.log("[2/2] /v1/responses + tools (x_search + web_search)");
  const tools = await callGrok({
    systemPrompt:
      "あなたは仮想通貨アナリストです。x_search と web_search を使ってリアルタイム情報を取得してください。",
    userPrompt:
      "BTC の過去 24 時間の X 投稿と暗号メディア記事から、センチメントとトピックを 200 字で要約してください。",
    maxTokens: 600,
    useTools: true,
  });
  console.log(`  content:    ${tools.content.slice(0, 300)}`);
  console.log(`  citations:  ${tools.citations?.length ?? 0} 件`);
  if (tools.citations && tools.citations.length > 0) {
    for (const url of tools.citations.slice(0, 3)) console.log(`    - ${url}`);
  }
  console.log(`  tokens:     input=${tools.usage.inputTokens} output=${tools.usage.outputTokens}`);

  console.log("\n✓ Grok API — OK (chat + agentic tools)");
}

main().catch((err) => {
  console.error("Grok smoke test FAILED:", err);
  process.exit(1);
});
