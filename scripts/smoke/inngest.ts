/**
 * Inngest Cloud REST API smoke test.
 *
 * Usage:
 *   pnpm smoke:prod:inngest <runId>
 *
 * runId は Inngest Cloud dashboard の Runs ページからコピペ。
 * 認証: INNGEST_API_KEY (read-only)。signing key は使わない。
 *
 * 確認内容:
 *   1. GET /v2/runs/{runId}              — run 全体の durationMs
 *   2. GET /v2/runs/{runId}/trace        — step ごとの durationMs (preflight / tier0 / ... / finalize)
 */

const BASE = "https://api.inngest.com";

interface RunResponse {
  data: {
    id: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    function: { id: string; name: string };
  };
}

interface Span {
  id?: string;
  name?: string;
  stepId?: string | null;
  status?: string;
  durationMs?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  stepOp?: string | null;
  childrenSpans?: Span[];
  children?: Span[];
}

interface TraceResponse {
  data: { rootSpan: Span };
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}\n${body}`);
  }
  return res.json() as Promise<T>;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function collectSteps(span: Span, depth = 0, out: Array<Span & { depth: number }> = []) {
  out.push({ ...span, depth });
  const kids = span.childrenSpans ?? span.children ?? [];
  for (const k of kids) collectSteps(k, depth + 1, out);
  return out;
}

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: pnpm smoke:prod:inngest <runId>");
    process.exit(1);
  }
  const token = process.env.INNGEST_API_KEY;
  if (!token) throw new Error("INNGEST_API_KEY is not set");

  console.log("=== Inngest REST API Smoke Test ===\n");
  console.log(`runId: ${runId}\n`);

  console.log("[1/2] GET /v2/runs/{runId}");
  const run = await get<RunResponse>(`/v2/runs/${runId}`, token);
  const r = run.data;
  console.log(`  function:  ${r.function?.name ?? "?"} (${r.function?.id ?? "?"})`);
  console.log(`  status:    ${r.status}`);
  console.log(`  started:   ${r.startedAt ?? "—"}`);
  console.log(`  ended:     ${r.endedAt ?? "—"}`);
  console.log(`  duration:  ${fmtMs(r.durationMs)}\n`);

  console.log("[2/2] GET /v2/runs/{runId}/trace");
  const trace = await get<TraceResponse>(`/v2/runs/${runId}/trace`, token);
  const spans = collectSteps(trace.data.rootSpan).filter((s) => s.depth > 0);
  if (spans.length === 0) {
    console.log("  (no child spans)");
  } else {
    const nameW = Math.max(8, ...spans.map((s) => (s.name ?? "").length));
    console.log(`  ${"step".padEnd(nameW)}  ${"status".padEnd(10)}  duration`);
    console.log(`  ${"-".repeat(nameW)}  ${"-".repeat(10)}  --------`);
    for (const s of spans) {
      const indent = "  ".repeat(s.depth - 1);
      const name = `${indent}${s.name ?? s.stepId ?? "?"}`.padEnd(nameW);
      const status = (s.status ?? "?").padEnd(10);
      console.log(`  ${name}  ${status}  ${fmtMs(s.durationMs)}`);
    }
  }

  console.log("\n✓ Inngest REST API — OK");
}

main().catch((err) => {
  console.error("Inngest smoke test FAILED:", err);
  process.exit(1);
});
