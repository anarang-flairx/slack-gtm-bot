export type DraftType = "initial" | "follow-up";

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
};
