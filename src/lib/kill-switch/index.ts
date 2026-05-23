import { db } from "@/db/client";
import {
  coins,
  marketSnapshots,
  portfolios,
  positions,
  systemEvents,
  systemState,
} from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { PositionStatusValue } from "@/lib/constants/enums";
import { executeExit } from "@/lib/executor";
import { formatJpy } from "@/lib/format/jpy";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { getRiskParams } from "@/lib/risk/params";
import { SINGLETON_ID } from "@/lib/system-control/constants";
import { and, desc, eq } from "drizzle-orm";

const logger = createLogger("kill-switch");

export interface KillSwitchCheckInput {
  strategyId: string;
}

export type SafetyTriggerKind = "killed" | "paused";

/**
 * サイクル終了後の安全チェック。
 *
 * - ポートフォリオ DD <= -50% → Kill Switch（全ポジション仮想成行クローズ + killed）
 * - 連続失敗 >= 3 → 自動一時停止（ポジション維持 + paused、LLM のみ止める）
 */
export async function checkAndTriggerKillSwitch(
  input: KillSwitchCheckInput,
): Promise<SafetyTriggerKind | false> {
  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, input.strategyId)).limit(1)
  )[0];
  if (!portfolio) return false;

  const [state, riskParams] = await Promise.all([
    db
      .select()
      .from(systemState)
      .where(eq(systemState.id, SINGLETON_ID))
      .limit(1)
      .then((r) => r[0]),
    getRiskParams(),
  ]);

  const open = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(
      and(
        eq(positions.strategyId, input.strategyId),
        eq(positions.status, PositionStatusValue.OPEN),
      ),
    );

  // §8: ticker 取得失敗時に position を silent skip すると DD が過小評価される。
  // フォールバック順:
  //   1. GMO ticker (現値)
  //   2. 直近 market_snapshots の ticker.last
  //   3. positions.peakPrice (保守的: trail で最も楽観的だがゼロよりマシ)
  //   4. positions.avgEntryPrice (建値、最も楽観的)
  //
  // FF: ここで解決した価格は kill-switch 発動時の close でも再利用する
  // (close 段で個別に ticker を引き直すと失敗 → silent skip でポジ残留する事故になる)
  const resolved = await Promise.all(
    open.map(({ position, coin }) => resolvePrice(position, coin)),
  );
  const marketValue = resolved.reduce(
    (sum, { price }, i) => sum + Number(open[i].position.quantity) * price,
    0,
  );
  const priceByCoinId = new Map<string, number>(resolved.map((r, i) => [open[i].coin.id, r.price]));
  const equity = Number(portfolio.cashJpy) + marketValue;

  // HWM-base DD (= capital-injection-adjusted、max from peak)。
  // - 各 kill-switch チェック時に HWM を equity で更新 (max)
  // - DD = (HWM - equity) / HWM、HWM <= 0 のときは評価しない (MM ガード相当)
  // - 入金/出金時は capital.ts 側で HWM を ± 入出金額 で調整 (performance 由来の peak だけ追う)
  const prevHwm = Number(portfolio.highWaterMarkJpy);
  const hwm = Math.max(prevHwm, equity);
  if (hwm > prevHwm) {
    await db
      .update(portfolios)
      .set({ highWaterMarkJpy: hwm.toFixed(4), updatedAt: new Date() })
      .where(eq(portfolios.id, portfolio.id));
  }
  const ddRatio = hwm > 0 ? (hwm - equity) / hwm : 0;
  const ddEvaluable = hwm > 0;

  const failureTriggered = state && state.consecutiveFailures >= riskParams.autoPauseThreshold;
  const ddTriggered = ddEvaluable && ddRatio >= riskParams.portfolioDdTrigger;

  if (ddTriggered) {
    const reason = `portfolio DD ${(ddRatio * 100).toFixed(1)}% (HWM ${formatJpy(hwm)})`;
    await triggerKillSwitch({
      strategyId: input.strategyId,
      open,
      priceByCoinId,
      reason,
      totalValue: equity,
      initial: hwm, // 通知用、"HWM 比" の意味
      ddRatio,
    });
    return "killed";
  }

  if (failureTriggered) {
    const failures = state?.consecutiveFailures ?? 0;
    await triggerAutoPauseDueToFailures({ strategyId: input.strategyId, failures });
    return "paused";
  }

  return false;
}

/**
 * §8 / FF: ticker → snapshot → peak → avg のフォールバック順で price を解決。
 * Kill Switch では DD 計算と close 段の両方で使う (close 段が ticker 単独で silent skip
 * すると killed なのにポジ残留する事故になる)。
 */
async function resolvePrice(
  position: typeof positions.$inferSelect,
  coin: typeof coins.$inferSelect,
): Promise<{ price: number; source: "ticker" | "snapshot" | "peak" | "avg" }> {
  let price = 0;
  try {
    const ticker = await getTicker(`${coin.symbol}_JPY`);
    price = Number(ticker[0]?.last ?? 0);
  } catch (err) {
    logger.warn(
      { symbol: coin.symbol, err },
      "Kill-switch: ticker fetch failed, falling back to snapshot/position price",
    );
  }
  if (price > 0) return { price, source: "ticker" };

  const snap = (
    await db
      .select({ ticker: marketSnapshots.ticker })
      .from(marketSnapshots)
      .where(eq(marketSnapshots.coinId, coin.id))
      .orderBy(desc(marketSnapshots.fetchedAt))
      .limit(1)
  )[0];
  const snapTicker = snap?.ticker as { last?: string } | null;
  if (snapTicker?.last) {
    const snapPrice = Number(snapTicker.last);
    if (snapPrice > 0) {
      logger.warn(
        { symbol: coin.symbol, price: snapPrice },
        "Kill-switch: using snapshot fallback",
      );
      return { price: snapPrice, source: "snapshot" };
    }
  }

  const peak = Number(position.peakPrice ?? 0);
  if (peak > 0) {
    logger.warn({ symbol: coin.symbol, price: peak }, "Kill-switch: using peak fallback");
    return { price: peak, source: "peak" };
  }

  const avg = Number(position.avgEntryPrice);
  logger.warn({ symbol: coin.symbol, price: avg }, "Kill-switch: using avg entry fallback");
  return { price: avg, source: "avg" };
}

async function triggerKillSwitch(input: {
  strategyId: string;
  open: { position: typeof positions.$inferSelect; coin: typeof coins.$inferSelect }[];
  priceByCoinId: Map<string, number>;
  reason: string;
  totalValue: number;
  initial: number;
  ddRatio: number;
}) {
  const { strategyId, open, priceByCoinId, reason, totalValue, initial, ddRatio } = input;

  logger.error({ strategyId, totalValue, ddRatio, reason }, "Kill Switch triggered");

  // GG: 緊急性が最も高いので並列実行。N 銘柄 × HTTP latency を回避。
  // FF: DD 計算で解決した価格をそのまま使う (ticker 単独で silent skip するパスを排除)。
  await Promise.all(
    open.map(async ({ position, coin }) => {
      try {
        const cached = priceByCoinId.get(coin.id);
        const lastPrice =
          cached && cached > 0 ? cached : (await resolvePrice(position, coin)).price;
        if (lastPrice <= 0) {
          throw new Error(`No usable price for ${coin.symbol} (all fallbacks returned 0)`);
        }
        await executeExit({
          strategyId,
          symbol: coin.symbol,
          decisionId: null,
          marketPrice: lastPrice,
          takerFeeRate: Number(coin.takerFeeRate),
          forced: true,
          reason: `kill switch: ${reason}`,
        });
      } catch (err) {
        logger.error({ err, symbol: coin.symbol }, "Kill switch close failed");
        await notify({
          level: "critical",
          title: `🚨 Kill Switch close 失敗 ${coin.symbol}`,
          body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          fields: {
            影響: "ポジション残ったまま killed 状態。手動 close 必要",
          },
        });
      }
    }),
  );

  await db
    .insert(systemState)
    .values({
      id: SINGLETON_ID,
      state: "killed",
      killReason: reason,
      killedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { state: "killed", killReason: reason, killedAt: new Date(), updatedAt: new Date() },
    });

  await db.insert(systemEvents).values({
    strategyId,
    kind: "kill_switch_triggered",
    severity: "critical",
    message: `Kill Switch: ${reason}`,
    payload: { totalValue, ddRatio, initialCash: initial },
  });

  await notify({
    level: "critical",
    title: "🚨 緊急停止 (Kill Switch) 発動",
    body: `**${reason}**\n全ポジションを強制クローズしました。システムは停止状態です。手動で再開してください。`,
    fields: {
      HWM: formatJpy(initial),
      現在資産: formatJpy(totalValue),
      ドローダウン: `${(ddRatio * 100).toFixed(1)}%`,
    },
  });
}

async function triggerAutoPauseDueToFailures(input: { strategyId: string; failures: number }) {
  const { strategyId, failures } = input;
  const reason = `${failures} consecutive cycle failures`;

  logger.warn({ strategyId, failures }, "Auto-pause due to consecutive failures");

  // KK: lastFailureKind も同時にリセット。残しておくと、再開後に異種エラーが来ても
  //     「同 kind 継続」と誤判定して 1 サイクル目から auto-pause へ駆け上がる。
  await db
    .insert(systemState)
    .values({
      id: SINGLETON_ID,
      state: "paused",
      consecutiveFailures: 0,
      lastFailureKind: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        state: "paused",
        consecutiveFailures: 0,
        lastFailureKind: null,
        updatedAt: new Date(),
      },
    });

  await db.insert(systemEvents).values({
    strategyId,
    kind: "system_paused",
    severity: "warning",
    message: `Auto-pause: ${reason}`,
    payload: { failures, trigger: "consecutive_failures" },
  });

  await notify({
    level: "warning",
    title: "⏸ 連続失敗のため自動一時停止",
    body: `判定パイプラインが **${failures} サイクル連続**で全銘柄失敗しました。\nポジションは維持されています。ダッシュボードから再開してください。`,
    fields: { 連続失敗: String(failures) },
  });
}
