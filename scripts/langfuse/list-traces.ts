/**
 * Langfuse に届いている直近のトレースを一覧表示する。
 * トレース送信が機能しているかの確認用。
 */
import { LangfuseClient } from "@langfuse/client";

async function main() {
  const lf = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await lf.api.trace.list({ fromTimestamp: since, limit: 20 });

  console.log(`Found ${res.data.length} traces in last 24h:\n`);
  for (const t of res.data) {
    console.log(`[${t.timestamp}] ${t.name ?? "(no name)"} id=${t.id}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
