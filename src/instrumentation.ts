export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@sentry/nextjs");
    const { initOpenTelemetry } = await import("@sentry/node");
    const { sentryOptions } = await import("../sentry.shared.config");
    const { langfuseProcessors } = await import("@/lib/telemetry");

    // skipOpenTelemetrySetup で Sentry 既定の OTel auto-setup を抑止し、
    // initOpenTelemetry で LangfuseSpanProcessor を相乗りさせる。
    // これがないと Sentry が独自 provider をグローバル登録し Langfuse 側に span が届かない。
    // @sentry/nextjs#init は union 型の Client を返すので、@sentry/node 側の
    // initOpenTelemetry が要求する NodeClient へキャスト (runtime=nodejs 分岐内なので安全)。
    const client = init({ ...sentryOptions, skipOpenTelemetrySetup: true }) as
      | Parameters<typeof initOpenTelemetry>[0]
      | undefined;
    if (client) {
      initOpenTelemetry(client, { spanProcessors: langfuseProcessors() });
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const { init } = await import("@sentry/nextjs");
    const { sentryOptions } = await import("../sentry.shared.config");
    init(sentryOptions);
  }
}

export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) => {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
