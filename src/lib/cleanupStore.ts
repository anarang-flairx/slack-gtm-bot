import { randomUUID } from "node:crypto";
import type {
  PendingCleanup,
  TakeCleanupResult,
} from "../types/pendingCleanup.js";

/** Pending marketing cleanups expire after 30 minutes (manual). */
export const CLEANUP_TTL_MS = 30 * 60 * 1000;

/** Scheduled daily cleanups stay clickable longer. */
export const SCHEDULED_CLEANUP_TTL_MS = 12 * 60 * 60 * 1000;

/** createdBy value for the daily 8am job — any user may approve/discard. */
export const SCHEDULED_CLEANUP_USER = "scheduled";

const pendingCleanups = new Map<string, PendingCleanup>();
const inFlight = new Set<string>();

function ttlMs(pending: PendingCleanup): number {
  return pending.createdBy === SCHEDULED_CLEANUP_USER
    ? SCHEDULED_CLEANUP_TTL_MS
    : CLEANUP_TTL_MS;
}

function isExpired(pending: PendingCleanup, now = Date.now()): boolean {
  return now - pending.createdAt > ttlMs(pending);
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingCleanups) {
    if (isExpired(pending, now)) {
      pendingCleanups.delete(id);
      inFlight.delete(id);
    }
  }
}

function canAct(pending: PendingCleanup, userId: string): boolean {
  return (
    pending.createdBy === SCHEDULED_CLEANUP_USER ||
    pending.createdBy === userId
  );
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
    }
    inFlight.delete(id);
    return { status: "not_found" };
  }

  if (!canAct(pending, userId)) {
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
