# 次にやりたい / 思いつきメモ

## 完了済 (2026-05-21 反映)

- **Tier 1 skip 時のバッジ**: 「未実行」→「スキップ」に統一 (T1 / commit fc8a9bf)
- **Decision 以外の inline バッジ廃止**: long_bias / greed / improving / impact 等のドメイン語を削除し、各 Tier セクションは「実行 / スキップ / エラー」3 状態のみ表示 (T2 / commit fc8a9bf)
- **cycle 詳細ページの折りたたみ化**: 銘柄ごと `<details>` で default 閉、summary に Entry/Exit バッジ、展開で Decision がすぐ見え、Tier 0/1/2 は nested details (T3+T4 / commit 8bca6ec)
- **開発用シード**: `scripts/dev/seed.ts` に存在。§17 で system_state の新カラム初期値も追加済。`pnpm tsx scripts/dev/seed.ts` で再シード可

## メモ用バックログ

(追加するときはここに)
