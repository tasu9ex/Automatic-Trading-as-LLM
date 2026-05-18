import { notify } from "@/lib/notifications";

async function main() {
  console.log("=== Discord Smoke Test ===\n");

  await notify({
    level: "success",
    title: "Discord smoke test — normal channel",
    body: "通常通知 (BUY/SELL/Critic 等) のルート確認",
    fields: { channel: "normal", webhook: "DISCORD_WEBHOOK_URL" },
  });
  console.log("[normal] 送信完了");

  await notify({
    level: "error",
    title: "Discord smoke test — errors channel",
    body: "エラー通知 (Sentry/Kill Switch 等) のルート確認",
    fields: { channel: "errors", webhook: "DISCORD_WEBHOOK_URL_ERRORS" },
  });
  console.log("[errors] 送信完了");

  console.log("\n✓ 両チャンネルに届いていれば OK");
}

main().catch((err) => {
  console.error("Discord smoke test FAILED:", err);
  process.exit(1);
});
