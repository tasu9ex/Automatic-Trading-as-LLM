/**
 * GMO コイン Private API クライアント (READ-ONLY)
 *
 * 重要: このファイルには GET エンドポイントのみ実装します。
 * 注文系 (POST /private/v1/order, /closeOrder, /cancelOrder 等) は
 * 実装してはいけません。 paper-trade ポリシーで実取引は禁止です。
 *
 * 必要 env:
 *   GMO_API_KEY
 *   GMO_API_SECRET
 *
 * 認証: HMAC-SHA256 (timestamp + method + path をシークレットで署名)
 *   docs: https://api.coin.z.com/docs/#authentication-private
 */

import { createHmac } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.gmo-private");

const PRIVATE_BASE = "https://api.coin.z.com/private";

export interface AssetEntry {
  /** 現物残高 (例: "BTC", "JPY") */
  symbol: string;
  /** 総額 */
  amount: string;
  /** 利用可能 (注文等で拘束されていない) */
  available: string;
  /** 換算レート (JPY 建て参考値) */
  conversionRate: string;
}

interface GmoPrivateResponse<T> {
  status: number;
  data: T;
  responsetime: string;
  messages?: Array<{ message_code: string; message_string: string }>;
}

function sign(secret: string, timestamp: string, method: string, path: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${method}${path}`).digest("hex");
}

async function gmoPrivateGet<T>(path: string): Promise<T> {
  const apiKey = process.env.GMO_API_KEY;
  const apiSecret = process.env.GMO_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("GMO_API_KEY / GMO_API_SECRET not set");
  }

  return runWith("gmo", async () => {
    const timestamp = String(Date.now());
    // GMO の署名対象は path のクエリ部分を含まない部分
    const pathNoQuery = path.split("?")[0] ?? path;
    const signature = sign(apiSecret, timestamp, "GET", pathNoQuery);

    const res = await fetch(`${PRIVATE_BASE}${path}`, {
      method: "GET",
      headers: {
        "API-KEY": apiKey,
        "API-TIMESTAMP": timestamp,
        "API-SIGN": signature,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, path, body }, "GMO private API error");
      throw new Error(`GMO private ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as GmoPrivateResponse<T>;
    if (json.status !== 0) {
      const msg = json.messages?.[0]?.message_string ?? "";
      throw new Error(`GMO private non-zero status: ${json.status} ${msg}`);
    }
    return json.data;
  });
}

/**
 * 現物口座の残高一覧を取得。
 * 0 残高の通貨も含まれるので、ポジション扱いするときは amount > 0 でフィルタ。
 */
export async function getAssets(): Promise<AssetEntry[]> {
  return gmoPrivateGet<AssetEntry[]>("/v1/account/assets");
}

export interface Execution {
  executionId: number;
  orderId: number;
  symbol: string;
  side: "BUY" | "SELL";
  settleType: string;
  size: string;
  price: string;
  lossGain: string;
  fee: string;
  /** ISO8601 例: "2026-04-25T13:22:11.123Z" */
  timestamp: string;
}

interface ExecutionsResponse {
  pagination: { currentPage: number; count: number };
  list: Execution[];
}

/**
 * 直近の約定履歴を取得 (最大 100 件 / page)。
 * 注文時の現物約定の SETTLE / 取引履歴に使う。
 */
export async function getLatestExecutions(params: {
  symbol: string;
  page?: number;
  count?: number;
}): Promise<ExecutionsResponse> {
  const q = new URLSearchParams({
    symbol: params.symbol,
    page: String(params.page ?? 1),
    count: String(params.count ?? 100),
  });
  return gmoPrivateGet<ExecutionsResponse>(`/v1/latestExecutions?${q.toString()}`);
}
