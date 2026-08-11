export type PendingCompanyDealContact = {
  id: string;
  name: string;
  email: string;
};

export type PendingCompanyDeal = {
  id: string;
  companyId: string;
  companyName: string;
  dealName: string;
  stageLabel: string;
  contacts: PendingCompanyDealContact[];
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeCompanyDealResult =
  | { status: "ok"; pending: PendingCompanyDeal }
  | { status: "not_found" }
  | { status: "forbidden" };
