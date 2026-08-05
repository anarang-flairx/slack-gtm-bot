import { randomUUID } from "node:crypto";
import type {
  PendingStageMove,
  TakeStageMoveResult,
} from "../types/pendingStageMove.js";

/** Pending stage moves expire after 30 minutes. */
export const STAGE_MOVE_TTL_MS = 30 * 60 * 1000;

const pendingMoves = new Map<string, PendingStageMove>();
const inFlight = new Set<string>();

function isExpired(pending: PendingStageMove, now = Date.now()): boolean {
  return now - pending.createdAt > STAGE_MOVE_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingMoves) {
    if (isExpired(pending, now)) {
      pendingMoves.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingStageMove(
  pending: Omit<PendingStageMove, "id" | "createdAt">,
): PendingStageMove {
  purgeExpired();

  const record: PendingStageMove = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingMoves.set(record.id, record);
  return record;
}

export function beginStageMoveAction(
  id: string,
  userId: string,
): TakeStageMoveResult {
  purgeExpired();
  const pending = pendingMoves.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingMoves.delete(id);
      inFlight.delete(id);
    }
    return { status: "not_found" };
  }

  if (pending.createdBy !== userId) {
    return { status: "forbidden" };
  }

  if (inFlight.has(id)) {
    return { status: "not_found" };
  }

  inFlight.add(id);
  return { status: "ok", pending };
}

export function completeStageMoveAction(id: string): void {
  pendingMoves.delete(id);
  inFlight.delete(id);
}

export function releaseStageMoveAction(id: string): void {
  inFlight.delete(id);
}

export function takeStageMove(
  id: string,
  userId: string,
): TakeStageMoveResult {
  const result = beginStageMoveAction(id, userId);
  if (result.status === "ok") {
    completeStageMoveAction(id);
  }
  return result;
}
