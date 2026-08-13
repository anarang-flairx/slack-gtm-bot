export type DealCreateContact = {
  id: string;
  name: string;
  email: string;
};

export type DealCreatePipelineOption = {
  id: string;
  label: string;
};

export type DealCreateStageOption = {
  id: string;
  label: string;
};

export type DealCreateRelationshipOption = {
  label: string;
  value: string;
};

export type DealCreateSession = {
  key: string;
  companyId: string;
  companyName: string;
  contacts: DealCreateContact[];
  force: boolean;
  existingDealCount: number;
  step: "company" | "pipeline" | "stage" | "relationship";
  companyOptions?: Array<{ id: string; name: string; domain: string }>;
  pipelines: DealCreatePipelineOption[];
  pipelineId?: string;
  pipelineLabel?: string;
  stages: DealCreateStageOption[];
  stageLabel?: string;
  relationshipOptions: DealCreateRelationshipOption[];
  createdBy: string;
  channelId: string;
  threadTs?: string;
  createdAt: number;
};
