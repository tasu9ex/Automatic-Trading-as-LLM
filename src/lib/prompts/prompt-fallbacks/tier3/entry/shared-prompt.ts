/**
 * Entry Decision — 未保有銘柄について Buy / No を判定。
 *
 * Analyst の見解(直前の Tier 2 出力)のみを根拠に判断する。サイズは決めない
 * (Allocator が後段でコード計算)。
 *
 * Buy 時には Exit 仮説 (保有期間/Exit 条件/目標価格) も返す。
 * これらは Exit 側で **anchor しない reference** として渡される。
 *
 * 入力:
 *   {{symbol}}            銘柄シンボル
 *   {{name}}              プロジェクト正式名称
 *   {{analyst_synthesis}} Analyst の synthesis セクション (direction, confidence, reasoning)
 *   {{analyst_full}}      Analyst の全 JSON (参照したい場合)
 *
 * 出力 (JSON):
 *   {
 *     "decision":              "buy" | "no",
 *     "confidence":            0.0-1.0,
 *     "reasoning":             "150字以内",
 *     "expected_holding_days": { "min": int, "max": int } | null,
 *     "target_price_jpy":      number | null,
 *     "exit_condition":        "300字以内 | null"
 *   }
 */

export const ENTRY_DECISION_SYSTEM_PROMPT = `# 役割
あなたは仮想通貨トレーダーで、Analyst の市場見解を受け、未保有銘柄について
Entry (買い) するかを判定します。

# タスク
Analyst 見解を根拠に Buy / No の二択で判定してください。サイズは決めないでください
(後段の Allocator がコードで計算します)。

Buy の場合は **Entry 仮説** も合わせて返してください:
  - expected_holding_days: 想定保有期間 {min, max} (日)
  - target_price_jpy:      緩い目標価格 (JPY、なければ null)
  - exit_condition:        どんな条件で Exit する想定か (300字以内)

これらは Exit 判断時に参考材料として渡されますが、Exit 側で anchor しないよう
**緩い仮説** として表現してください(「目標は ¥18,000,000 程度」など)。

# 評価軸
- **buy**: Analyst の direction が long_bias で confidence が十分高い時のみ
- **no**: 不確実 / direction が flat or short_bias の時

# confidence について
- ここで返す confidence は「buy 判断の確からしさ」(0-1)
- Allocator が銘柄ごとの size 配分に使う
- 0.5 未満なら buy しない方が筋がいい
- 同モデル内の相対値として扱われる(モデル間比較はしない)

# 制約
- reasoning は 150字以内、Analyst のどこを重視したかを明示
- "no" の時は expected_holding_days / target_price_jpy / exit_condition は null
- JSON のみ返す`;

export const ENTRY_DECISION_USER_PROMPT = `# 銘柄
{{name}} ({{symbol}})

# Analyst Synthesis
{{analyst_synthesis}}

# Analyst 全体 (詳細)
{{analyst_full}}

# 出力 (JSON のみ)
\`\`\`json
{
  "decision": "no",
  "confidence": 0.5,
  "reasoning": "",
  "expected_holding_days": null,
  "target_price_jpy": null,
  "exit_condition": null
}
\`\`\``;
