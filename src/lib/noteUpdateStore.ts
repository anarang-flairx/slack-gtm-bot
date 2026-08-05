import { randomUUID } from "node:crypto";
import type {
  PendingNoteUpdate,
  TakeNoteUpdateResult,
} from "../types/pendingNote.js";

/** Pending note updates expire after 30 minutes. */
export const NOTE_UPDATE_TTL_MS = 30 * 60 * 1000;

const pendingUpdates = new Map<string, PendingNoteUpdate>();
const inFlight = new Set<string>();

function isExpired(pending: PendingNoteUpdate, now = Date.now()): boolean {
  return now - pending.createdAt > NOTE_UPDATE_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingUpdates) {
    if (isExpired(pending, now)) {
      pendingUpdates.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingNoteUpdate(
  pending: Omit<PendingNoteUpdate, "id" | "createdAt">,
): PendingNoteUpdate {
  purgeExpired();

  const record: PendingNoteUpdate = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingUpdates.set(record.id, record);
  return record;
}

export function beginNoteUpdateAction(
  id: string,
  userId: string,
): TakeNoteUpdateResult {
  purgeExpired();
  const pending = pendingUpdates.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingUpdates.delete(id);
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

export function completeNoteUpdateAction(id: string): void {
  pendingUpdates.delete(id);
  inFlight.delete(id);
}

export function releaseNoteUpdateAction(id: string): void {
  inFlight.delete(id);
}

export function takeNoteUpdate(
  id: string,
  userId: string,
): TakeNoteUpdateResult {
  const result = beginNoteUpdateAction(id, userId);
  if (result.status === "ok") {
    completeNoteUpdateAction(id);
  }
  return result;
}
