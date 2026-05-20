/**
 * リスク管理 / セーフティ閾値の単一ソース。
 *
 * - 連続失敗 auto-pause / kill-switch 発火閾値
 * - per-coin 配分上限
 * - portfolio DD 上限
 *
 * 旧来は `cycle/phases.ts` と `kill-switch/index.ts` に同値が重複定義されていた (§20)。
 * 1 箇所変更すれば全体に伝播するよう一元化する。
 */

/** 連続失敗カウンタがこの値に達したら system_state を paused にする */
export const AUTO_PAUSE_THRESHOLD = 3;

/** ポートフォリオ DD がこの比率を下回ったら kill-switch (全 close + killed) */
export const PORTFOLIO_DD_TRIGGER = 0.5;

/** 1 銘柄あたりの最大配分比率 (= 現金 × この値) */
export const PER_COIN_MAX_RATIO = 0.25;

/** 1 銘柄あたりの最小配分 (これ未満は 0 にクランプ) */
export const PER_COIN_MIN_JPY = 5000;

/** 総ポートフォリオ配分の上限比率 (1.0 = 100%) */
export const TOTAL_MAX_RATIO = 1.0;
