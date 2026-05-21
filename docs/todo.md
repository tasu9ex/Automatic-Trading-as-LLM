# TODO — 残作業

Phase 1-4 (Tier S/A/B/C) は完了済み。詳細は git log の以下 commit 参照:

- `460d3fb` Phase 1 (Tier S 致命的バグ修正)
- `995a8d2` Phase 2 (Tier A ロジック / パフォ / 緊急 pause)
- `c4fd630` Phase 3 (Tier B UX / セキュリティ / データ整合性)
- `3cf52b0` Phase 4 (Tier C 整理・細部)
- `1fe7edd` Critic 再設計 (Exit dry-run → Critic → safety 実行) + UI 刷新
- (このコミット) 複雑度警告 6 件解消

以下が残作業。

---

## 1. 動作確認 (paper mode)

複雑度リファクタの前後で実機検証する項目。すべて paper mode で。

- [ ] **Steady cycle**: 1-2 サイクル正常完走 (Tier0〜finalize、Discord 通知あり)
- [ ] **二段リスクモデル**: `perCoinTotalMaxRatio` を 0.4 等に絞った状態で、既存 mtm が cap に到達 → 新規 Entry が Clipper で削られることを確認 (default 1.0 では check されない)
- [ ] **HWM-base DD (capital-injection-adjusted)**:
  - `pnpm capital:local deposit 100000` で HWM が +¥100k 上がる
  - Kill Switch チェック時に HWM が max 更新される
- [ ] **Langfuse**: 各 LLM の API コスト単価が正確に反映されているか(usage × 単価 vs Langfuse 表示の突合)

---
