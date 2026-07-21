import type { ProspectFields } from "../lib/parseProspect.js";

export type PendingProspect = {
  id: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  displayName: string;
  fields: ProspectFields;
  createdBy: string;
  channelId: string;
  createdAt: number;
};

export type TakeProspectResult =
  | { status: "ok"; pending: PendingProspect }
  | { status: "not_found" }
  | { status: "forbidden" };
