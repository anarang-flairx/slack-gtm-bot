import { randomUUID } from "node:crypto";
import type { PendingDraft, TakeDraftResult } from "../types/draft.js";

/** Pending drafts expire after 30 minutes. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

const pendingDrafts = new Map<string, PendingDraft>();
const inFlight = new Set<string>();

function isExpired(draft: PendingDraft, now = Date.now()): boolean {
  return now - draft.createdAt > DRAFT_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, draft] of pendingDrafts) {
    if (isExpired(draft, now)) {
      pendingDrafts.delete(id);
      inFlight.delete(id);
    }
  }
}

export function saveDraft(
  draft: Omit<PendingDraft, "id" | "createdAt">,
): PendingDraft {
  purgeExpired();

  const record: PendingDraft = {
    ...draft,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingDrafts.set(record.id, record);
  return record;
}

export function getDraft(id: string): PendingDraft | undefined {
  purgeExpired();
  const draft = pendingDrafts.get(id);
  if (!draft) {
    return undefined;
  }
  if (isExpired(draft)) {
    pendingDrafts.delete(id);
    inFlight.delete(id);
    return undefined;
  }
  return draft;
}

/**
 * Authorize and lock a draft for an action without deleting it yet.
 * Call completeDraftAction on success, or releaseDraftAction on failure.
 */
export function beginDraftAction(id: string, userId: string): TakeDraftResult {
  purgeExpired();
  const draft = pendingDrafts.get(id);

  if (!draft || isExpired(draft)) {
    if (draft) {
      pendingDrafts.delete(id);
      inFlight.delete(id);
    }
    return { status: "not_found" };
  }

  if (draft.createdBy !== userId) {
    return { status: "forbidden" };
  }

  if (inFlight.has(id)) {
    return { status: "not_found" };
  }

  inFlight.add(id);
  return { status: "ok", draft };
}

export function completeDraftAction(id: string): void {
  pendingDrafts.delete(id);
  inFlight.delete(id);
}

export function releaseDraftAction(id: string): void {
  inFlight.delete(id);
}

/** Authorize, then remove the draft (for discard). */
export function takeDraft(id: string, userId: string): TakeDraftResult {
  const result = beginDraftAction(id, userId);
  if (result.status === "ok") {
    completeDraftAction(id);
  }
  return result;
}

export function deleteDraft(id: string): void {
  pendingDrafts.delete(id);
  inFlight.delete(id);
}
