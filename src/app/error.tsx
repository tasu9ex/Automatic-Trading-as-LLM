"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Z: production では stack 非表示 (digest だけ案内し、詳細は Sentry / Vercel logs 側で追う)
  const isProduction = process.env.NODE_ENV === "production";

  useEffect(() => {
    Sentry.captureException(error);
    console.error("[PageError]", error);
  }, [error]);

  return (
    <main
      style={{
        padding: "2rem",
        maxWidth: 960,
        margin: "0 auto",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <h2 style={{ color: "#b91c1c" }}>ページエラー</h2>
      <button
        type="button"
        onClick={reset}
        style={{
          padding: "0.5rem 1rem",
          marginBottom: "1rem",
          cursor: "pointer",
          borderRadius: 6,
          border: "1px solid #999",
          background: "#fff",
        }}
      >
        再試行
      </button>
      <section style={{ marginBottom: "1rem" }}>
        <h3 style={{ marginBottom: "0.25rem" }}>Message</h3>
        <pre
          style={{
            background: "#fef2f2",
            padding: "0.75rem",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message || "(production-stripped — Vercel logs で digest 検索)"}
        </pre>
      </section>
      {error.digest && (
        <section style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: "0.25rem" }}>Digest</h3>
          <pre style={{ background: "#f3f4f6", padding: "0.75rem", borderRadius: 6 }}>
            {error.digest}
          </pre>
        </section>
      )}
      {!isProduction && error.stack && (
        <section>
          <h3 style={{ marginBottom: "0.25rem" }}>Stack</h3>
          <pre
            style={{
              background: "#f9fafb",
              padding: "0.75rem",
              borderRadius: 6,
              fontSize: 12,
              overflowX: "auto",
            }}
          >
            {error.stack}
          </pre>
        </section>
      )}
      {isProduction && (
        <p style={{ color: "#6b7280", fontSize: 13 }}>
          詳細は Sentry / Vercel logs で digest を検索してください。
        </p>
      )}
    </main>
  );
}
