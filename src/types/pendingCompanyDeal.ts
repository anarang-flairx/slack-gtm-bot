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
  pipelineId: string;
  pipelineLabel: string;
  stageLabel: string;
  /** lifecycle for sales pipelines; relationship for Partnership pipeline */
  companyFieldKind: "lifecycle" | "relationship";
  companyFieldLabel: string;
  contacts: PendingCompanyDealContact[];
  /** When true, create even if the company already has deals. */
  force?: boolean;
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};

export type TakeCompanyDealResult =
  | { status: "ok"; pending: PendingCompanyDeal }
  | { status: "not_found" }
  | { status: "forbidden" };
