# TODO — 残作業

Phase 1-4 (Tier S/A/B/C) は完了済み。詳細は git log の以下 commit 参照:

- `460d3fb` Phase 1 (Tier S 致命的バグ修正)
- `995a8d2` Phase 2 (Tier A ロジック / パフォ / 緊急 pause)
- `c4fd630` Phase 3 (Tier B UX / セキュリティ / データ整合性)
- `3cf52b0` Phase 4 (Tier C 整理・細部)

以下が残作業。

---

## 1. 複雑度警告の解消 (biome `noExcessiveCognitiveComplexity`、6 件)

閾値は 25 据え置き。**売買中核を触る #1 と #4 は paper mode で 1-2 サイクル正常完了を確認してから着手**。

| # | 対象 | 現複雑度 | 工数 | 分割案 |
|---|---|---|---|---|
| 1 | [`cycle/phases.ts` finalize](../src/lib/cycle/phases.ts#L576) | 96 | 大 | `buildFinalizeContext` / `runCriticDecision` / `executeExits` / `executeEntries` / `buildCycleNotification` の 5 ブロックに分割。ALL-or-NOTHING (Critic 必須化) / EE (`state` 非上書き) / DD (`completedAt` 更新位置) を破らないこと |
| 2 | [`cycle/phases.ts` tier3Decisions 内ループ](../src/lib/cycle/phases.ts#L407) | 33 | 中 | `runEntryForCoin(ctx)` / `runExitForCoin(ctx, openPos)` に切り出す |
| 3 | [`risk/clipper.ts` applyRiskClipper](../src/lib/risk/clipper.ts#L46) | 40 | 中 | 段 1 cap (per-cycle) / 段 2 cap (per-coin total) / total cap / floor の 4 段を分けて関数化 |
| 4 | [`app/page.tsx:363` recentCycles map](../src/app/page.tsx#L363) | 41 | 小 | `criticDecisionLabel(c)` / `criticDecisionVariant(c)` / `cycleStatusBadge(c)` のヘルパー化 |
| 5 | [`app/page.tsx:248` openPositions map](../src/app/page.tsx#L248) | 26 | 小 | 銘柄行レンダリングを `<PositionRow position={p} />` コンポーネントに切り出す |
| 6 | [`components/dashboard/system-controls.tsx` SystemControls](../src/components/dashboard/system-controls.tsx#L45) | 30 | 中 | ConfirmDialog 駆動ロジックとボタンレンダリングを分離、楽観更新は `useOptimistic` に置き換え検討 |

### 完了条件

- [ ] biome lint warning 0 件
- [ ] paper mode 1 サイクル完走 (#1 / #2 着手後)
- [ ] 既存テスト全通過 (`critic-mandatory.test.ts` の fail-open 検出が機能)

---

## 2. 動作確認 (paper mode)

複雑度リファクタの前後で実機検証する項目。すべて paper mode で。

- [ ] **Steady cycle**: 1-2 サイクル正常完走 (Tier0〜finalize、Discord 通知あり)
- [ ] **二段リスクモデル**: `perCoinTotalMaxRatio` を 0.4 等に絞った状態で、既存 mtm が cap に到達 → 新規 Entry が Clipper で削られることを確認 (default 1.0 では check されない)
- [ ] **HWM-base DD (capital-injection-adjusted)**:
  - `pnpm capital:local deposit 100000` で HWM が +¥100k 上がる
  - Kill Switch チェック時に HWM が max 更新される
- [ ] **Langfuse**: 各 LLM の API コスト単価が正確に反映されているか(usage × 単価 vs Langfuse 表示の突合)

---

## 3. 機能追加

- [ ] **入金 UI フォーム**: 現状 `pnpm capital:local deposit <amount>` の CLI のみ。dashboard に「入金/出金」フォームを追加して `portfolio_capital_events` に記録できるようにする
