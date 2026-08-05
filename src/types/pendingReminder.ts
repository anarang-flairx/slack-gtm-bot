import type { NoteRecordType } from "../integrations/hubspot.js";

export type PendingReminder = {
  id: string;
  recordType: NoteRecordType;
  recordId: string;
  recordName: string;
  note: string;
  days: number;
  dueMs: number;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeReminderResult =
  | { status: "ok"; pending: PendingReminder }
  | { status: "not_found" }
  | { status: "forbidden" };
