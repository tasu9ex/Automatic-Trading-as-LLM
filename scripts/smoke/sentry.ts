import { captureError, initSentry, shutdownSentry } from "@/lib/telemetry/sentry-setup";

async function main() {
  initSentry();

  const testError = new Error("Sentry smoke test — このエラーは意図的なテストです");
  testError.name = "SmokeTestError";

  captureError(testError, {
    tags: { script: "smoke/sentry", env: process.env.NODE_ENV ?? "development" },
  });

  console.log(
    "Sentry にテストエラーを送信しました。Dashboard と Discord errors ch を確認してください。",
  );

  await shutdownSentry();
}

main();
