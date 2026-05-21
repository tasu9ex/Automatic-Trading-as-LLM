/**
 * GMO Public API から取引所形式の銘柄リストを取得し、coins テーブルに upsert。
 *
 * Usage:
 *   pnpm db:local:sync-coins
 *
 * 既存銘柄: minOrderSize 等を更新。新規銘柄: 追加。
 * GMO で扱われなくなった銘柄は enabled=false に。
 * 手数料率は GMO API では取れないので、デフォルト値で埋める(後で UI から調整)。
 */

import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { getSymbols } from "@/lib/clients/gmo";
import { createLogger } from "@/lib/logging";
import { eq } from "drizzle-orm";

const logger = createLogger("dev.sync-coins");

/** GMO 取引所形式の典型的な BTC/ETH を含む現物銘柄(_JPY ペア)のみ対象 */
function parseSpotSymbol(raw: string): string | null {
  // GMO は "BTC", "ETH" (現物) と "BTC_JPY" (レバ) の表記混在
  // 現物は単独シンボル "BTC", "ETH" 等で返ってくる(取引所形式)
  if (raw.includes("_")) return null; // _JPY 系は除外
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

async function main() {
  console.log("Fetching GMO symbols...");
  const symbols = await getSymbols();

  // 取引所形式現物のみ(レバ _JPY は除外)
  const spotSymbols = symbols
    .map((s) => ({ ...s, parsed: parseSpotSymbol(s.symbol) }))
    .filter((s): s is typeof s & { parsed: string } => s.parsed !== null);

  console.log(`Found ${spotSymbols.length} spot symbols`);

  const remoteSymbolSet = new Set(spotSymbols.map((s) => s.parsed));

  let inserted = 0;
  let updated = 0;
  for (const s of spotSymbols) {
    const symbol = s.parsed;
    const name = COIN_NAMES[symbol] ?? symbol;
    const existing = (await db.select().from(coins).where(eq(coins.symbol, symbol)).limit(1))[0];

    if (existing) {
      await db
        .update(coins)
        .set({
          name, // COIN_NAMES に新規追加された場合の反映
          minOrderSize: s.minOrderSize,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(coins.id, existing.id));
      updated++;
    } else {
      await db.insert(coins).values({
        symbol,
        name,
        minOrderSize: s.minOrderSize,
        // GMO 公開 API では手数料は取れない、現物の典型値で仮置き
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      });
      inserted++;
    }
  }

  // 取扱終了銘柄は disabled に
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

  logger.info({ inserted, updated, disabled, total: spotSymbols.length }, "Sync done");
  console.log(`Inserted: ${inserted}, Updated: ${updated}, Disabled: ${disabled}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
