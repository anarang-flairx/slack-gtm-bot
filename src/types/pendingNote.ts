import type { NoteRecordType } from "../integrations/hubspot.js";

export type PendingNoteUpdate = {
  id: string;
  recordType: NoteRecordType;
  recordId: string;
  recordName: string;
  recordDetail: string;
  note: string;
  createdBy: string;
  channelId: string;
  createdAt: number;
};

export type TakeNoteUpdateResult =
  | { status: "ok"; pending: PendingNoteUpdate }
  | { status: "not_found" }
  | { status: "forbidden" };
