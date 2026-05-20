/**
 * 通知スモークテスト — LLM / DB / Executor を経由せず notify() を直接叩く。
 *
 * 17 種の通知 (📤発注 / 🟢🔵🔴 約定 / ⏰期限切れ / 🚫拒否 / ❌キャンセル / ⚠️逆指値発火 /
 * 🚨Entry失敗 / 🚨Exit失敗 / 🛑Critic VETO / ✏️Critic modify / 🔁サイクル完了 /
 * 💰コスト集計 / 💰コスト取得失敗 / 🛑サイクル中断 / ⏸自動一時停止 / 🚨Kill Switch close 失敗 /
 * 🚨Kill Switch 発動) を 4 シナリオに分けて流す。
 *
 * 送信先: DISCORD_WEBHOOK_URL_SMOKE (本番 webhook は触らない)
 * 各通知間 1.5 秒 sleep (Discord rate limit 回避 + 視認性)。
 *
 * Usage: pnpm smoke:notifications
 */

// ===== 本番 webhook 環境変数を SMOKE 用に差し替え (import より前) =====
const smokeUrl = process.env.DISCORD_WEBHOOK_URL_SMOKE;
if (!smokeUrl) {
  console.error("DISCORD_WEBHOOK_URL_SMOKE が未設定。.env.local に追記してください。");
  process.exit(1);
}
process.env.DISCORD_WEBHOOK_URL = smokeUrl;
process.env.DISCORD_WEBHOOK_URL_ERRORS = smokeUrl;

import { notify } from "@/lib/notifications";

const SLEEP_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fmtJpySigned = (v: number) =>
  `${v >= 0 ? "+" : "-"}¥${Math.abs(Math.round(v)).toLocaleString()}`;

let counter = 0;
const step = async (label: string, fn: () => Promise<void>) => {
  counter++;
  console.log(`[${counter.toString().padStart(2, "0")}] ${label}`);
  await fn();
  await sleep(SLEEP_MS);
};

async function scenarioA() {
  console.log("\n=== Scenario A: 通常運用 (Critic approve) ===");

  // 1. 📤 発注 (buy) BTC
  await step("📤 発注 (buy) BTC", () =>
    notify({
      level: "info",
      title: "📤 発注 BTC (買)",
      fields: {
        数量: (30000 / 10720000).toFixed(8),
        参考価格: `¥${(10720000).toLocaleString()}`,
        想定金額: `¥${Math.round((30000 / 10720000) * 10720000).toLocaleString()}`,
        予算: `¥${(30000).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 2. 🟢 約定 (買) BTC
  await step("🟢 約定 (買) BTC", () => {
    const qty = 0.0028;
    const price = 10720000;
    const gross = qty * price;
    const fee = gross * 0.001;
    return notify({
      level: "success",
      title: "🟢 約定 BTC (買)",
      fields: {
        数量: qty.toFixed(8),
        価格: `¥${Math.round(price).toLocaleString()}`,
        約定金額: `¥${Math.round(gross).toLocaleString()}`,
        手数料: `¥${fee.toFixed(0)}`,
        支払総額: `¥${Math.round(gross + fee).toLocaleString()}`,
        残現金: `¥${(469954).toLocaleString()}`,
      },
    });
  });

  // 3. 📤 発注 (sell) ETH
  await step("📤 発注 (sell) ETH", () =>
    notify({
      level: "info",
      title: "📤 発注 ETH (売)",
      body: "llm decision",
      fields: {
        数量: (0.05).toFixed(8),
        参考価格: `¥${(620000).toLocaleString()}`,
        想定金額: `¥${(31000).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 4. 🔵 約定 (売) ETH 利益
  await step("🔵 約定 (売) ETH 利益", () => {
    const qty = 0.05;
    const price = 620000;
    const gross = qty * price;
    const fee = gross * 0.001;
    return notify({
      level: "success",
      title: "🔵 約定 ETH (売)",
      body: "llm decision",
      fields: {
        数量: qty.toFixed(8),
        価格: `¥${Math.round(price).toLocaleString()}`,
        約定金額: `¥${Math.round(gross).toLocaleString()}`,
        手数料: `¥${fee.toFixed(0)}`,
        受領額: `¥${Math.round(gross - fee).toLocaleString()}`,
        損益: `+¥${(4500).toLocaleString()}`,
        残現金: `¥${(500923).toLocaleString()}`,
      },
    });
  });

  // 5. 📤 発注 (sell) SOL
  await step("📤 発注 (sell) SOL", () =>
    notify({
      level: "info",
      title: "📤 発注 SOL (売)",
      body: "llm decision",
      fields: {
        数量: (0.3).toFixed(8),
        参考価格: `¥${(38500).toLocaleString()}`,
        想定金額: `¥${(11550).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 6. 🔴 約定 (売) SOL 損失
  await step("🔴 約定 (売) SOL 損失", () => {
    const qty = 0.3;
    const price = 38500;
    const gross = qty * price;
    const fee = gross * 0.001;
    return notify({
      level: "warning",
      title: "🔴 約定 SOL (売)",
      body: "llm decision",
      fields: {
        数量: qty.toFixed(8),
        価格: `¥${Math.round(price).toLocaleString()}`,
        約定金額: `¥${Math.round(gross).toLocaleString()}`,
        手数料: `¥${fee.toFixed(0)}`,
        受領額: `¥${Math.round(gross - fee).toLocaleString()}`,
        損益: `-¥${(3200).toLocaleString()}`,
        残現金: `¥${(508262).toLocaleString()}`,
      },
    });
  });

  // 7. 📤 発注 (sell 50%) XRP — Critic が close_pct を 100→50 に修正
  await step("📤 発注 (sell 50%) XRP", () =>
    notify({
      level: "info",
      title: "📤 発注 XRP (売 50%)",
      body: "llm decision (critic modified 100%→50%)",
      fields: {
        数量: (285.337).toFixed(8),
        参考価格: `¥${(219).toLocaleString()}`,
        想定金額: `¥${(62489).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 8. 🔵 約定 (売 50%) XRP 部分利益
  await step("🔵 約定 (売 50%) XRP", () => {
    const qty = 285.337;
    const price = 219;
    const gross = qty * price;
    const fee = gross * 0.001;
    return notify({
      level: "success",
      title: "🔵 約定 XRP (売 50%)",
      body: "llm decision (critic modified 100%→50%)",
      fields: {
        数量: qty.toFixed(8),
        価格: `¥${Math.round(price).toLocaleString()}`,
        約定金額: `¥${Math.round(gross).toLocaleString()}`,
        手数料: `¥${fee.toFixed(0)}`,
        受領額: `¥${Math.round(gross - fee).toLocaleString()}`,
        損益: `+¥${(7200).toLocaleString()}`,
        残現金: `¥${(570751).toLocaleString()}`,
      },
    });
  });

  // 9. ⏰ 期限切れ LTC (買)
  await step("⏰ 期限切れ LTC", () =>
    notify({
      level: "warning",
      title: "⏰ 期限切れ LTC (買)",
      body: "TTL 24h 超過で自動失効",
      fields: {
        数量: (2.5).toFixed(8),
        参考価格: `¥${(12500).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 10. 🔁 サイクル完了
  await step("🔁 サイクル完了", () => {
    const cashAfter = 570751;
    const initialCash = 1000000;
    const totalAsset = cashAfter + 124798 + 12100; // XRP残半分 + BNB
    const realizedPnlCycle = 4500 - 3200 + 7200;
    const cumulativePnl = totalAsset - initialCash;
    const bodyParts = [
      "**📥 新規 Entry**\n• BTC: ¥30,000",
      "**📕 Close**\n• ETH\n• SOL\n• XRP",
      "**📊 保有ポジション (3)**\n• BTC: 0.002800 @ ¥10,720,000 (¥30,016)\n• XRP: 285.337000 @ ¥219 (¥62,489)\n• BNB: 0.020000 @ ¥605,000 (¥12,100)",
      [
        "**💰 現金**: ¥570,751",
        `**🏦 資産時価総額**: ¥${totalAsset.toLocaleString()}`,
        `**📈 実現損益 (今回)**: ${fmtJpySigned(realizedPnlCycle)}`,
        `**🧮 累計損益**: ${fmtJpySigned(cumulativePnl)} (初期 ¥${initialCash.toLocaleString()})`,
      ].join("\n"),
    ];
    return notify({
      level: "info",
      title: "🔁 サイクル完了",
      body: bodyParts.join("\n\n"),
      fields: {
        処理銘柄: "5/5",
        Tier1スキップ: "1/5",
        entry: "1件",
        exit: "3件",
        Critic判定: "承認",
        所要時間: "42.7秒",
      },
    });
  });

  // 11. 💰 サイクルコスト集計
  await step("💰 サイクルコスト集計", () =>
    notify({
      level: "info",
      title: "💰 サイクルコスト集計",
      body: [
        "**モデル別内訳**",
        "• claude-opus-4-7: 4 回 / $0.1820",
        "• claude-sonnet-4-6: 5 回 / $0.0640",
        "• claude-haiku-4-5: 5 回 / $0.0080",
      ].join("\n"),
      fields: {
        "今回 (USD)": "$0.2540",
        "今回 (JPY)": "¥38",
        "累計 (USD)": "$12.4830",
        "累計 (JPY)": "¥1,872",
      },
    }),
  );
}

async function scenarioB() {
  console.log("\n=== Scenario B: Critic modify + 失敗系 ===");

  // 12. ✏️ Critic modify
  await step("✏️ Critic modify", () =>
    notify({
      level: "info",
      title: "✏️ Critic 修正 (MODIFY)",
      body: "DOGE は短期過熱気味のため Buy 額を 50% に圧縮。ADA は損切り進度遅いため Exit 比率を 100% に増強。",
      fields: {
        買い修正: '{"DOGE":7500}',
        売り修正: '{"ADA":{"close_pct":100}}',
      },
    }),
  );

  // 13. 📤 発注 (buy) DOGE
  await step("📤 発注 (buy) DOGE", () =>
    notify({
      level: "info",
      title: "📤 発注 DOGE (買)",
      fields: {
        数量: (321.0).toFixed(8),
        参考価格: `¥${(23.4).toLocaleString()}`,
        想定金額: `¥${(7511).toLocaleString()}`,
        予算: `¥${(7500).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 14. 🚨 Entry 失敗 DOGE
  await step("🚨 Entry 失敗 DOGE", () =>
    notify({
      level: "error",
      title: "🚨 Entry 失敗 DOGE",
      body: "Insufficient cash balance: required ¥7,511, available ¥3,200",
      fields: {
        配分: "¥7,500",
        参考価格: "¥23",
        影響: "この銘柄の Entry をスキップ、次サイクル待ち",
      },
    }),
  );

  // 15. 📤 発注 (sell) ADA
  await step("📤 発注 (sell) ADA", () =>
    notify({
      level: "info",
      title: "📤 発注 ADA (売)",
      body: "llm decision (critic modified 60%→100%)",
      fields: {
        数量: (180.5).toFixed(8),
        参考価格: `¥${(82).toLocaleString()}`,
        想定金額: `¥${(14801).toLocaleString()}`,
        TTL: "24h",
      },
    }),
  );

  // 16. 🚨 Exit 失敗 ADA
  await step("🚨 Exit 失敗 ADA", () =>
    notify({
      level: "error",
      title: "🚨 Exit 失敗 ADA",
      body: "DB transaction failed: deadlock detected on positions row",
      fields: {
        意図: "100% 決済",
        参考価格: "¥82",
        影響: "ポジション保有継続、price-monitor SL に依存",
      },
    }),
  );

  // 17. ⚠️ 逆指値発火 BNB
  await step("⚠️ 逆指値発火 BNB", () =>
    notify({
      level: "warning",
      title: "⚠️ 逆指値発火: BNB",
      body: "種別: `stop_market_peak` (成行強制、スリッページ 0.3%)",
      fields: {
        発火価格: `¥${(575000).toLocaleString()}`,
        直近安値: `¥${(573200).toLocaleString()}`,
        ピーク: `¥${(632000).toLocaleString()}`,
      },
    }),
  );

  // 18. 🔴 約定 (売 強制) BNB
  await step("🔴 約定 (売 強制) BNB", () => {
    const qty = 0.02;
    const price = 575000 * (1 - 0.003);
    const gross = qty * price;
    const fee = gross * 0.001;
    const slippage = qty * 575000 * 0.003;
    return notify({
      level: "warning",
      title: "🔴 約定 BNB (売) 強制",
      body: "auto SL: stop_market_peak",
      fields: {
        数量: qty.toFixed(8),
        価格: `¥${Math.round(price).toLocaleString()}`,
        約定金額: `¥${Math.round(gross).toLocaleString()}`,
        手数料: `¥${fee.toFixed(0)}`,
        受領額: `¥${Math.round(gross - fee).toLocaleString()}`,
        損益: `-¥${(580).toLocaleString()}`,
        残現金: `¥${(581918).toLocaleString()}`,
        スリッページ: `¥${slippage.toFixed(0)}`,
      },
    });
  });

  // 19. 🚫 拒否 LTC
  await step("🚫 拒否 LTC", () =>
    notify({
      level: "warning",
      title: "🚫 拒否 LTC (売)",
      body: "Insufficient asset balance (expected 2.5 LTC, available 1.2 LTC)",
      fields: {
        数量: (2.5).toFixed(8),
        参考価格: `¥${(12500).toLocaleString()}`,
      },
    }),
  );

  // 20. ❌ キャンセル
  await step("❌ キャンセル (manual)", () =>
    notify({
      level: "info",
      title: "❌ キャンセル DOT (買)",
      body: "manual cancel via dashboard",
      fields: {
        数量: (4.0).toFixed(8),
        参考価格: `¥${(950).toLocaleString()}`,
      },
    }),
  );

  // 21. 🔁 サイクル完了 (modify)
  await step("🔁 サイクル完了 (modify)", () =>
    notify({
      level: "info",
      title: "🔁 サイクル完了",
      body: [
        "**📕 Close**\n• ADA\n• BNB",
        "**📊 保有ポジション (2)**\n• BTC: 0.002800 @ ¥10,720,000 (¥30,016)\n• XRP: 285.337000 @ ¥219 (¥62,489)",
        "**💰 現金**: ¥581,918\n**🏦 資産時価総額**: ¥674,423\n**📈 実現損益 (今回)**: -¥580\n**🧮 累計損益**: -¥325,577 (初期 ¥1,000,000)",
      ].join("\n\n"),
      fields: {
        処理銘柄: "5/5",
        Tier1スキップ: "0/5",
        entry: "0件",
        exit: "1件",
        Critic判定: "修正",
        所要時間: "38.4秒",
      },
    }),
  );

  // 22. 💰 コスト取得失敗
  await step("💰 コスト取得失敗", () =>
    notify({
      level: "warning",
      title: "💰 コスト取得失敗",
      body: "Langfuse から該当サイクルの cost 取得不可。累計に加算されない。",
      fields: { サイクル: "9c4f1a2b" },
    }),
  );
}

async function scenarioC() {
  console.log("\n=== Scenario C: Critic VETO + サイクル中断 ===");

  // 23. 🛑 Critic VETO
  await step("🛑 Critic 拒否 (VETO)", () =>
    notify({
      level: "warning",
      title: "🛑 Critic 拒否 (VETO)",
      body: "現在のマクロ環境 (FOMC 前日 + 高 VIX) で新規 Entry はリスクオーバー。全 buy シグナルを拒否。Exit は次サイクル再評価推奨。",
      fields: {
        拒否買い: "BTC: ¥30,000, ETH: ¥15,000, SOL: ¥10,000",
        拒否売り: "XRP, BNB",
      },
    }),
  );

  // 24. 🛑 サイクル中断
  await step("🛑 サイクル中断", () =>
    notify({
      level: "error",
      title: "🛑 サイクル中断 (tier2-analyst)",
      body: [
        "**エラー**",
        "```",
        "AnthropicError: 529 overloaded_error - Anthropic API is overloaded, please try again later.",
        "```",
        "**推定原因**: Anthropic Opus 過負荷 or ITPM レート超過",
        "**推奨対応**: Langfuse で詳細確認、次サイクル待ち",
      ].join("\n"),
      fields: {
        サイクル: "a1b2c3d4",
        連続失敗: "1/3 (あと 2)",
        次サイクル: "2026-05-20 13:00",
      },
    }),
  );
}

async function scenarioD() {
  console.log("\n=== Scenario D: Kill Switch 発火 ===");

  // 25. ⏸ 自動一時停止
  await step("⏸ 自動一時停止", () =>
    notify({
      level: "warning",
      title: "⏸ 連続失敗のため自動一時停止",
      body: "判定パイプラインが **3 サイクル連続**で全銘柄失敗しました。\nポジションは維持されています。ダッシュボードから再開してください。",
      fields: { 連続失敗: "3" },
    }),
  );

  // 26. 🚨 Kill Switch close 失敗
  await step("🚨 Kill Switch close 失敗 BTC", () =>
    notify({
      level: "critical",
      title: "🚨 Kill Switch close 失敗 BTC",
      body: "GMO API timeout after 30s (POST /v1/order)",
      fields: {
        影響: "ポジション残ったまま killed 状態。手動 close 必要",
      },
    }),
  );

  // 27. 🚨 緊急停止 (Kill Switch) 発動
  await step("🚨 緊急停止 (Kill Switch) 発動", () =>
    notify({
      level: "critical",
      title: "🚨 緊急停止 (Kill Switch) 発動",
      body: "**drawdown 25.3% > threshold 20.0%**\n全ポジションを強制クローズしました。システムは停止状態です。手動で再開してください。",
      fields: {
        元本: `¥${(1000000).toLocaleString()}`,
        現在資産: `¥${(746500).toLocaleString()}`,
        ドローダウン: "25.3%",
      },
    }),
  );
}

async function main() {
  console.log("通知スモークテスト 開始 (送信先: DISCORD_WEBHOOK_URL_SMOKE)");
  console.log(`各通知間 sleep ${SLEEP_MS}ms\n`);

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();

  console.log(`\n✓ 全 ${counter} 通知 送信完了`);
}

main().catch((err) => {
  console.error("通知スモークテスト FAILED:", err);
  process.exit(1);
});
