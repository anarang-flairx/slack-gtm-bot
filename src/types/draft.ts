export type DraftType = "intro" | "event-follow-up";

export type PendingDraft = {
  id: string;
  type: DraftType;
  contactId: string;
  dealId: string;
  to: string;
  subject: string;
  body: string;
  contactName: string;
  companyName: string;
  dealStage: string;
  createdBy: string;
  channelId: string;
  createdAt: number;
};

export type TakeDraftResult =
  | { status: "ok"; draft: PendingDraft }
  | { status: "not_found" }
  | { status: "forbidden" };
