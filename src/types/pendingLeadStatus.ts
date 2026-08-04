export type PendingLeadStatus = {
  id: string;
  contactId: string;
  contactName: string;
  contactEmail: string;
  statusLabel: string;
  statusValue: string;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeLeadStatusResult =
  | { status: "ok"; pending: PendingLeadStatus }
  | { status: "not_found" }
  | { status: "forbidden" };
