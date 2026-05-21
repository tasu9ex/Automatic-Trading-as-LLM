/**
 * Critic レビュー UI。
 *
 * 「現在ポジション → 計画 (Δ) → 修正後 (Δ)」の流れで表示。
 * 計画と修正後の両方を「現在からの差分」付き絶対値で並べ、
 * Critic が変えたセルだけ ⚠ マーキング。
 */

type ExecutionPlan = {
  entries?: Record<string, number>;
  exits?: Record<string, { closePct: number; qtyToClose: number; expectedCashJpy: number }>;
  currentPositions?: Record<string, number>;
  plannedPositions?: Record<string, number>;
  projectedCashJpy?: number;
  clipperChanges?: Array<{ symbol: string; reason: string; from: number; to: number }>;
};

function isRecordOfNumbers(v: unknown): v is Record<string, number> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "number")
  );
}

function asPlan(v: unknown): ExecutionPlan | null {
  if (v === null || typeof v !== "object") return null;
  return v as ExecutionPlan;
}

function fmtJpy(v: number): string {
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function fmtDelta(delta: number): { text: string; cls: string } {
  if (Math.abs(delta) < 1) return { text: "(変化なし)", cls: "text-muted-foreground" };
  const sign = delta > 0 ? "+" : "-";
  return {
    text: `(${sign}${fmtJpy(Math.abs(delta))})`,
    cls: delta > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
  };
}

function PositionList({
  current,
  target,
  title,
  diffFrom,
}: {
  current: Record<string, number>;
  target: Record<string, number>;
  title: string;
  /** ⚠ マークの基準。target の値がこの map と違っていたら印 */
  diffFrom?: Record<string, number>;
}) {
  const symbols = Array.from(
    new Set([...Object.keys(current), ...Object.keys(target), ...Object.keys(diffFrom ?? {})]),
  ).sort();
  if (symbols.length === 0) {
    return (
      <div>
        <div className="mb-1 text-muted-foreground text-xs">{title}</div>
        <p className="text-muted-foreground text-xs">対象なし</p>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 text-muted-foreground text-xs">{title}</div>
      <ul className="space-y-1 font-mono text-xs">
        {symbols.map((sym) => {
          const cur = current[sym] ?? 0;
          const tgt = target[sym] ?? 0;
          const delta = tgt - cur;
          const d = fmtDelta(delta);
          const changedByCritic =
            diffFrom !== undefined && Math.abs((diffFrom[sym] ?? 0) - tgt) > 1;
          return (
            <li key={sym} className="flex items-center gap-2">
              <span className="w-12 font-bold">{sym}</span>
              <span className="w-24 text-right">{fmtJpy(tgt)}</span>
              <span className={`${d.cls} w-32`}>{d.text}</span>
              {changedByCritic && (
                <span
                  className="rounded bg-amber-200 px-1 text-amber-900 dark:bg-amber-700 dark:text-amber-100"
                  title="Critic が計画から変更"
                >
                  ⚠
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CriticPlanView({
  decision,
  executionPlan,
  modifiedPositions,
}: {
  decision: string;
  executionPlan: unknown;
  modifiedPositions: unknown;
}) {
  const plan = asPlan(executionPlan);
  if (!plan) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
        {JSON.stringify(executionPlan, null, 2)}
      </pre>
    );
  }
  const current = plan.currentPositions ?? {};
  const planned = plan.plannedPositions ?? {};
  const modified = isRecordOfNumbers(modifiedPositions) ? modifiedPositions : null;

  // veto: 修正後は全銘柄 current 維持 (何も起きない)
  if (decision === "veto") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PositionList current={current} target={planned} title="ポジション案" />
        <div>
          <div className="mb-1 text-muted-foreground text-xs">修正結果</div>
          <p className="font-mono text-rose-600 text-xs dark:text-rose-400">
            (全件キャンセル — 何も実行しない)
          </p>
        </div>
      </div>
    );
  }

  // approve: 修正欄を出さない (1 列)
  if (decision !== "modify" || modified === null) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PositionList current={current} target={planned} title="ポジション案" />
      </div>
    );
  }

  // modify: 2 列、修正側に Critic 差分の ⚠ を付ける
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <PositionList current={current} target={planned} title="ポジション案" />
      <PositionList current={current} target={modified} title="修正結果" diffFrom={planned} />
    </div>
  );
}
