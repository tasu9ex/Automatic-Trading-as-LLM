/**
 * サイクル単位の状態 (= Critic 出力 + 失敗/in_flight/auto-skip の合成) 表示用ヘルパー。
 *
 * "approve" / "modify" / "veto" — Critic 出力そのもの
 * "failed" / "in_flight"        — Critic 未到達 (queries 側で出し分け)
 * "auto-skip"                   — Critic コール節約 (HH: approve と擬制し、UI のみ別表示)
 */

type CriticStatus =
  | "approve"
  | "modify"
  | "veto"
  | "failed"
  | "in_flight"
  | "auto-skip"
  | (string & {});

const LABEL: Record<string, string> = {
  approve: "承認",
  modify: "修正",
  veto: "拒否",
  failed: "失敗",
  in_flight: "実行中",
  "auto-skip": "審査スキップ",
};

export function criticStatusLabel(status: CriticStatus): string {
  return LABEL[status] ?? status;
}

export type CriticStatusVariant = "default" | "destructive" | "outline";

export function criticStatusVariant(status: CriticStatus): CriticStatusVariant {
  if (status === "approve") return "default";
  if (status === "modify" || status === "in_flight" || status === "auto-skip") return "outline";
  // veto / failed / 未知の値は destructive
  return "destructive";
}
