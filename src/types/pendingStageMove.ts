export type PendingStageMove = {
  id: string;
  dealId: string;
  dealName: string;
  currentStageLabel: string;
  targetStageId: string;
  targetStageLabel: string;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeStageMoveResult =
  | { status: "ok"; pending: PendingStageMove }
  | { status: "not_found" }
  | { status: "forbidden" };
