import { randomUUID } from "node:crypto";
import type {
  PendingLeadStatus,
  TakeLeadStatusResult,
} from "../types/pendingLeadStatus.js";

/** Pending lead-status changes expire after 30 minutes. */
export const LEAD_STATUS_TTL_MS = 30 * 60 * 1000;

const pending = new Map<string, PendingLeadStatus>();
const inFlight = new Set<string>();

function isExpired(record: PendingLeadStatus, now = Date.now()): boolean {
  return now - record.createdAt > LEAD_STATUS_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, record] of pending) {
    if (isExpired(record, now)) {
      pending.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingLeadStatus(
  record: Omit<PendingLeadStatus, "id" | "createdAt">,
): PendingLeadStatus {
  purgeExpired();

  const stored: PendingLeadStatus = {
    ...record,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pending.set(stored.id, stored);
  return stored;
}

export function beginLeadStatusAction(
  id: string,
  userId: string,
): TakeLeadStatusResult {
  purgeExpired();
  const record = pending.get(id);

  if (!record || isExpired(record)) {
    if (record) {
      pending.delete(id);
      inFlight.delete(id);
    }
    return { status: "not_found" };
  }

  if (record.createdBy !== userId) {
    return { status: "forbidden" };
  }

  if (inFlight.has(id)) {
    return { status: "not_found" };
  }

  inFlight.add(id);
  return { status: "ok", pending: record };
}

export function completeLeadStatusAction(id: string): void {
  pending.delete(id);
  inFlight.delete(id);
}

export function releaseLeadStatusAction(id: string): void {
  inFlight.delete(id);
}

export function takeLeadStatus(
  id: string,
  userId: string,
): TakeLeadStatusResult {
  const result = beginLeadStatusAction(id, userId);
  if (result.status === "ok") {
    completeLeadStatusAction(id);
  }
  return result;
}
