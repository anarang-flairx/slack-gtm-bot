import { randomUUID } from "node:crypto";
import type {
  PendingProspect,
  TakeProspectResult,
} from "../types/pendingProspect.js";

/** Pending prospect creates expire after 30 minutes. */
export const PROSPECT_TTL_MS = 30 * 60 * 1000;

const pendingProspects = new Map<string, PendingProspect>();
const inFlight = new Set<string>();

function isExpired(pending: PendingProspect, now = Date.now()): boolean {
  return now - pending.createdAt > PROSPECT_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingProspects) {
    if (isExpired(pending, now)) {
      pendingProspects.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingProspect(
  pending: Omit<PendingProspect, "id" | "createdAt">,
): PendingProspect {
  purgeExpired();

  const record: PendingProspect = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingProspects.set(record.id, record);
  return record;
}

export function beginProspectAction(
  id: string,
  userId: string,
): TakeProspectResult {
  purgeExpired();
  const pending = pendingProspects.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingProspects.delete(id);
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

export function completeProspectAction(id: string): void {
  pendingProspects.delete(id);
  inFlight.delete(id);
}

export function releaseProspectAction(id: string): void {
  inFlight.delete(id);
}

export function takeProspect(id: string, userId: string): TakeProspectResult {
  const result = beginProspectAction(id, userId);
  if (result.status === "ok") {
    completeProspectAction(id);
  }
  return result;
}
