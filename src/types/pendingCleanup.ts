export type PendingCleanupContact = {
  id: string;
  name: string;
  email: string;
  reason: string;
  summary?: string;
  activitySnippet?: string;
  /** Subject lines of the logged emails, newest first. */
  emailSubjects?: string[];
};

export type PendingCleanupCompany = {
  id: string;
  name: string;
  domain: string;
  reason: string;
  summary?: string;
  activitySnippet?: string;
  /** Subject lines of the logged emails, newest first. */
  emailSubjects?: string[];
};

/**
 * "marketing" — a single classified contact or company.
 * "unnamed-company" — a blank-name company plus every contact on it, archived
 * together on one approval.
 */
export type PendingCleanupKind = "marketing" | "unnamed-company";

export type PendingCleanup = {
  id: string;
  kind: PendingCleanupKind;
  contacts: PendingCleanupContact[];
  companies: PendingCleanupCompany[];
  truncated: boolean;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
  /** Added to Never Log on approve, so the email logger skips these senders. */
  neverLogEmails?: string[];
  neverLogDomains?: string[];
};

export type TakeCleanupResult =
  | { status: "ok"; pending: PendingCleanup }
  | { status: "not_found" }
  | { status: "forbidden" };
