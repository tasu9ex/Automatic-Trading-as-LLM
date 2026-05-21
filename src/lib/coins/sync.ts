/**
 * GMO Public API から取引所形式の銘柄リストを取得し、coins テーブルに upsert。
 *
 * 仕様:
 *   - 新規: insert で `enabled=false` (= 表示はされるが判定対象外)。UI から有効化する想定。
 *   - 既存: minOrderSize / name を更新するが `enabled` は触らない (ユーザーの toggle を保つ)。
 *   - 取扱終了 (remote 側で消えた): `enabled=false` に倒して silently 持ち続ける (履歴のため)。
 *
 * `scripts/dev/sync-coins.ts` (CLI) と `scripts/dev/seed.ts` (reset 時の初期投入) の両方から呼ぶ。
 */

import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { getSymbols } from "@/lib/clients/gmo";
import { createLogger } from "@/lib/logging";
import { eq } from "drizzle-orm";

const logger = createLogger("lib.coins.sync");

/** GMO 取引所形式の現物銘柄 (_JPY 系レバを除外) */
function parseSpotSymbol(raw: string): string | null {
  if (raw.includes("_")) return null;
  if (raw.includes("/")) return null;
  return raw.toUpperCase();
}

const COIN_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BCH: "Bitcoin Cash",
  LTC: "Litecoin",
  XRP: "XRP",
  XEM: "NEM",
  XLM: "Stellar Lumens",
  BAT: "Basic Attention Token",
  OMG: "OMG Network",
  XTZ: "Tezos",
  QTUM: "Qtum",
  ENJ: "Enjin Coin",
  DOT: "Polkadot",
  ATOM: "Cosmos",
  MKR: "Maker",
  DAI: "Dai",
  XYM: "Symbol",
  MONA: "Monacoin",
  ADA: "Cardano",
  MATIC: "Polygon",
  DOGE: "Dogecoin",
  SOL: "Solana",
  ASTR: "Astar Network",
  FIL: "Filecoin",
  SAND: "The Sandbox",
  AXS: "Axie Infinity",
  APE: "ApeCoin",
  OAS: "Oasys",
  MANA: "Decentraland",
  GRT: "The Graph",
  MASK: "Mask Network",
  CHZ: "Chiliz",
  LDO: "Lido DAO",
  AVAX: "Avalanche",
  SHIB: "Shiba Inu",
  TRX: "Tron",
  ONDO: "Ondo",
  BNB: "BNB",
  OP: "Optimism",
  ARB: "Arbitrum",
  SUI: "Sui",
  LINK: "Chainlink",
  FCR: "FC Ryukyu Coin",
  NAC: "NOT A HOTEL COIN",
  WILD: "Wilder World",
};

export interface SyncCoinsResult {
  inserted: number;
  updated: number;
  disabled: number;
  total: number;
}

export async function syncCoinsFromGmo(): Promise<SyncCoinsResult> {
  const symbols = await getSymbols();

  const spotSymbols = symbols
    .map((s) => ({ ...s, parsed: parseSpotSymbol(s.symbol) }))
    .filter((s): s is typeof s & { parsed: string } => s.parsed !== null);

  const remoteSymbolSet = new Set(spotSymbols.map((s) => s.parsed));

  let inserted = 0;
  let updated = 0;
  for (const s of spotSymbols) {
    const symbol = s.parsed;
    const name = COIN_NAMES[symbol] ?? symbol;
    const existing = (await db.select().from(coins).where(eq(coins.symbol, symbol)).limit(1))[0];

    if (existing) {
      // 既存銘柄: enabled は触らない (UI からユーザーが設定済の状態を保つ)
      await db
        .update(coins)
        .set({
          name,
          minOrderSize: s.minOrderSize,
          updatedAt: new Date(),
        })
        .where(eq(coins.id, existing.id));
      updated++;
    } else {
      // 新規: enabled=false で取り込む (UI から有効化する)
      await db.insert(coins).values({
        symbol,
        name,
        minOrderSize: s.minOrderSize,
        // GMO 公開 API では手数料は取れない、現物の典型値で仮置き
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: false,
      });
      inserted++;
    }
  }

  // 取扱終了銘柄は強制 disable (削除はしない、履歴を残す)
  const allCoins = await db.select().from(coins);
  let disabled = 0;
  for (const c of allCoins) {
    if (!remoteSymbolSet.has(c.symbol) && c.enabled) {
      await db
        .update(coins)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(coins.id, c.id));
      disabled++;
    }
  }

  const result = { inserted, updated, disabled, total: spotSymbols.length };
  logger.info(result, "Coin sync done");
  return result;
}
