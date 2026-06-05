/**
 * Sentry CLI: 本番の Issue 一覧 / Event 詳細 (stack trace + breadcrumbs) を引く。
 *
 * Usage:
 *   pnpm sentry:prod                 # 直近 14d の unresolved issue 一覧
 *   pnpm sentry:prod <SHORT_ID>      # 特定 issue の最新 event (stack / breadcrumbs / HTTP 集計)
 *     例: pnpm sentry:prod JAVASCRIPT-NEXTJS-18
 *
 * 認証: SENTRY_USER_ADMIN (event:read 以上を持つ User Auth Token)。
 *   ソースマップ用の SENTRY_AUTH_TOKEN は read 権限が無いので使わない。
 *
 * org / project は env で上書き可 (SENTRY_ORG_SLUG / SENTRY_PROJECT_SLUG)。
 */

const ORG = process.env.SENTRY_ORG_SLUG ?? "automatic-trading-as-llm-ch";
const PROJECT = process.env.SENTRY_PROJECT_SLUG ?? "javascript-nextjs";
const BASE = "https://sentry.io/api/0";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function levelColor(level: string): string {
  if (level === "fatal" || level === "error") return RED;
  if (level === "warning") return YELLOW;
  return DIM;
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

interface Issue {
  id: string;
  shortId: string;
  title: string;
  level: string;
  count: string;
  lastSeen: string;
  culprit?: string;
}

async function listIssues(token: string): Promise<void> {
  const issues = await get<Issue[]>(
    `/projects/${ORG}/${PROJECT}/issues/?statsPeriod=14d&query=is:unresolved&limit=25`,
    token,
  );
  console.log(`${BOLD}━━━ Unresolved issues (${issues.length}, last 14d) ━━━${RESET}`);
  for (const i of issues) {
    const c = levelColor(i.level);
    const last = (i.lastSeen ?? "").slice(0, 19).replace("T", " ");
    console.log(
      `  ${c}${i.level.padEnd(8)}${RESET} ${DIM}×${i.count.padStart(3)}${RESET}  ${last}  ${CYAN}${i.shortId}${RESET}  ${i.title.slice(0, 80)}`,
    );
  }
  console.log(`\n${DIM}詳細: pnpm sentry:prod <SHORT_ID>${RESET}`);
}

// Sentry event payload — 触るフィールドだけを緩く型付け (any は使わない)。
interface SentryFrame {
  function?: string;
  filename?: string;
  module?: string;
  lineNo?: number;
  inApp?: boolean;
}
interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: SentryFrame[] };
}
interface SentryCrumb {
  category?: string;
  message?: string;
  data?: { url?: string; status_code?: number | string };
}
interface SentryEntry {
  type: string;
  data?: { values?: unknown[] };
}
interface SentryEvent {
  title?: string;
  dateCreated?: string;
  culprit?: string;
  tags?: Array<{ key: string; value: string }>;
  entries?: SentryEntry[];
}

async function resolveIssueId(shortId: string, token: string): Promise<string | null> {
  // shortId → group を直接解決する専用エンドポイント (statsPeriod 非依存)。
  const res = await get<{ group?: { id?: string } }>(
    `/organizations/${ORG}/shortids/${shortId}/`,
    token,
  );
  return res.group?.id ?? null;
}

function printStacktrace(event: SentryEvent): void {
  for (const entry of event.entries ?? []) {
    if (entry.type !== "exception") continue;
    for (const exc of (entry.data?.values ?? []) as SentryException[]) {
      console.log(`\n${RED}${exc.type}${RESET}: ${(exc.value ?? "").slice(0, 300)}`);
      const frames = exc.stacktrace?.frames ?? [];
      for (const f of frames.slice(-25)) {
        const fn = f.function ?? "?";
        const fname = f.filename ?? f.module ?? "?";
        const mark = f.inApp ? `${CYAN}*${RESET}` : " ";
        console.log(`  ${mark} ${fname}:${f.lineNo ?? "?"}  ${DIM}${fn}${RESET}`);
      }
    }
  }
}

function printBreadcrumbHttp(event: SentryEvent): void {
  for (const entry of event.entries ?? []) {
    if (entry.type !== "breadcrumbs") continue;
    const crumbs = (entry.data?.values ?? []) as SentryCrumb[];
    const hosts: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    let httpCount = 0;
    for (const c of crumbs) {
      if (c.category !== "http") continue;
      httpCount += 1;
      const url = c.data?.url ?? "";
      const host = url.includes("://") ? url.split("/")[2] : url.slice(0, 40);
      hosts[host] = (hosts[host] ?? 0) + 1;
      const sc = String(c.data?.status_code ?? "?");
      statuses[sc] = (statuses[sc] ?? 0) + 1;
    }
    if (httpCount > 0) {
      console.log(`\n${BOLD}HTTP breadcrumbs (${httpCount}/${crumbs.length})${RESET}`);
      console.log(`  hosts:    ${JSON.stringify(hosts)}`);
      console.log(`  statuses: ${JSON.stringify(statuses)}`);
    }
    // 直近の非 http breadcrumb (log / console など) を数件
    const nonHttp = crumbs.filter((c) => c.category !== "http").slice(-6);
    if (nonHttp.length) {
      console.log(`\n${BOLD}Last non-http breadcrumbs${RESET}`);
      for (const c of nonHttp) {
        console.log(`  [${c.category}] ${(c.message ?? "").slice(0, 110)}`);
      }
    }
  }
}

async function showEvent(shortId: string, token: string): Promise<void> {
  const issueId = await resolveIssueId(shortId, token);
  if (!issueId) {
    console.error(`Issue not found: ${shortId}`);
    process.exit(1);
  }
  const event = await get<SentryEvent>(
    `/organizations/${ORG}/issues/${issueId}/events/latest/`,
    token,
  );
  const tags: Record<string, string> = {};
  for (const t of event.tags ?? []) tags[t.key] = t.value;

  console.log(`${BOLD}${event.title ?? shortId}${RESET}`);
  console.log(`  shortId:     ${shortId}`);
  console.log(`  dateCreated: ${event.dateCreated ?? "—"}`);
  console.log(`  culprit:     ${event.culprit ?? "—"}`);
  for (const k of ["environment", "transaction", "runtime", "server_name", "url"]) {
    if (tags[k]) console.log(`  ${k}: ${tags[k]}`);
  }
  printStacktrace(event);
  printBreadcrumbHttp(event);
}

async function main() {
  const token = process.env.SENTRY_USER_ADMIN;
  if (!token) throw new Error("SENTRY_USER_ADMIN is not set (.env.prod / .env.local)");
  const shortId = process.argv[2];
  if (shortId) {
    await showEvent(shortId, token);
  } else {
    await listIssues(token);
  }
}

main().catch((err) => {
  console.error("sentry CLI FAILED:", err);
  process.exit(1);
});

// import の無い純 fetch スクリプトはグローバルスコープ扱いになり、
// 同じく import 無しの scripts/smoke/inngest.ts と識別子衝突する。
// 空 export でモジュール化してスコープを分離する。
export {};
