import { randomUUID } from "node:crypto";
import type {
  PendingCleanup,
  TakeCleanupResult,
} from "../types/pendingCleanup.js";

/** Pending marketing cleanups expire after 30 minutes. */
export const CLEANUP_TTL_MS = 30 * 60 * 1000;

const pendingCleanups = new Map<string, PendingCleanup>();
const inFlight = new Set<string>();

function isExpired(pending: PendingCleanup, now = Date.now()): boolean {
  return now - pending.createdAt > CLEANUP_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingCleanups) {
    if (isExpired(pending, now)) {
      pendingCleanups.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingCleanup(
  pending: Omit<PendingCleanup, "id" | "createdAt">,
): PendingCleanup {
  purgeExpired();

  const record: PendingCleanup = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingCleanups.set(record.id, record);
  return record;
}

export function beginCleanupAction(
  id: string,
  userId: string,
): TakeCleanupResult {
  purgeExpired();
  const pending = pendingCleanups.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingCleanups.delete(id);
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

export function completeCleanupAction(id: string): void {
  pendingCleanups.delete(id);
  inFlight.delete(id);
}

export function releaseCleanupAction(id: string): void {
  inFlight.delete(id);
}

export function takeCleanup(id: string, userId: string): TakeCleanupResult {
  const result = beginCleanupAction(id, userId);
  if (result.status === "ok") {
    completeCleanupAction(id);
  }
  return result;
}
