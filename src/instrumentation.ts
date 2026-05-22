export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@sentry/nextjs");
    const { sentryOptions } = await import("../sentry.shared.config");
    const { setupOtelWithSentry } = await import("@/lib/telemetry");

    // Sentry の auto OTel setup は SentrySampler が tracesSampleRate=0.0 で
    // span を NOT_RECORD 化するため、Langfuse 側に span が届かなくなる。
    // skip + 自前 setupOtelWithSentry (AlwaysOnSampler) で両方に流す。
    const client = init({ ...sentryOptions, skipOpenTelemetrySetup: true });
    if (client) {
      // @sentry/nextjs#init は union 型 Client を返すため NodeClient へキャスト
      // (runtime=nodejs 分岐内なので安全)。
      setupOtelWithSentry(client as Parameters<typeof setupOtelWithSentry>[0]);
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
