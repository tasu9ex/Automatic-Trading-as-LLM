export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@sentry/nextjs");
    const { sentryOptions } = await import("../sentry.shared.config");
    init(sentryOptions);
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const { init } = await import("@sentry/nextjs");
    const { sentryOptions } = await import("../sentry.shared.config");
    init(sentryOptions);
  }
}
