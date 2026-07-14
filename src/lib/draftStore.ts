import { randomUUID } from "node:crypto";
import type { PendingDraft } from "../types/draft.js";

const pendingDrafts = new Map<string, PendingDraft>();

export function saveDraft(draft: Omit<PendingDraft, "id">): PendingDraft {
  const record: PendingDraft = {
    ...draft,
    id: randomUUID(),
  };
  pendingDrafts.set(record.id, record);
  return record;
}

export function getDraft(id: string): PendingDraft | undefined {
  return pendingDrafts.get(id);
}

export function deleteDraft(id: string): void {
  pendingDrafts.delete(id);
}
