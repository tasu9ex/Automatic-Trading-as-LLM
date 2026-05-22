export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@sentry/nextjs");
    const { sentryOptions } = await import("../sentry.shared.config");
    const { langfuseProcessors } = await import("@/lib/telemetry");
    init({
      ...sentryOptions,
      // Sentry が握る OTel TracerProvider に LangfuseSpanProcessor を co-processor として相乗り。
      // これがないと本番から Langfuse へ trace が届かない (Sentry が先に provider を握るため)。
      // ブラウザ bundle に Node-only な LangfuseSpanProcessor が混入しないよう server runtime 限定。
      openTelemetrySpanProcessors: langfuseProcessors(),
    });
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
