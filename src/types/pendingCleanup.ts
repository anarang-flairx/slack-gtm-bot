export type PendingCleanupContact = {
  id: string;
  name: string;
  email: string;
  reason: string;
  summary?: string;
  activitySnippet?: string;
};

export type PendingCleanupCompany = {
  id: string;
  name: string;
  domain: string;
  reason: string;
  summary?: string;
  activitySnippet?: string;
};

export type PendingCleanup = {
  id: string;
  contacts: PendingCleanupContact[];
  companies: PendingCleanupCompany[];
  truncated: boolean;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeCleanupResult =
  | { status: "ok"; pending: PendingCleanup }
  | { status: "not_found" }
  | { status: "forbidden" };
