const HUBSPOT_BASE = "https://api.hubapi.com";

function getToken(): string {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN in .env");
  }
  return token;
}

async function hubspotFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HubSpot API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

type HubSpotSearchResponse = {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
};

type HubSpotAssociationResponse = {
  results: Array<{ toObjectId: string }>;
};

type HubSpotPipeline = {
  id: string;
  stages: Array<{ id: string; label: string }>;
};

type HubSpotPipelinesResponse = {
  results: HubSpotPipeline[];
};

export type HubSpotContactContext = {
  contactId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  jobTitle: string;
  companyName: string;
  dealId: string;
  dealName: string;
  dealStage: string;
  leadSource: string;
};

let stageLabelCache: Map<string, string> | null = null;

async function getStageLabels(): Promise<Map<string, string>> {
  if (stageLabelCache) {
    return stageLabelCache;
  }

  const data = await hubspotFetch<HubSpotPipelinesResponse>(
    "/crm/v3/pipelines/deals",
  );

  const pipelineId = process.env.HUBSPOT_PIPELINE_ID;
  const pipeline = pipelineId
    ? data.results.find((p) => p.id === pipelineId)
    : data.results[0];

  if (!pipeline) {
    throw new Error("No HubSpot deal pipeline found");
  }

  stageLabelCache = new Map(
    pipeline.stages.map((stage) => [stage.id, stage.label]),
  );

  return stageLabelCache;
}

function parseContactName(input: string): {
  firstName: string;
  lastName: string;
} {
  const parts = input.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

export async function findContactContext(
  contactName: string,
): Promise<HubSpotContactContext | HubSpotContactContext[]> {
  const { firstName, lastName } = parseContactName(contactName);

  const filters =
    lastName.length > 0
      ? [
          {
            propertyName: "firstname",
            operator: "EQ",
            value: firstName,
          },
          {
            propertyName: "lastname",
            operator: "EQ",
            value: lastName,
          },
        ]
      : [
          {
            propertyName: "firstname",
            operator: "CONTAINS_TOKEN",
            value: firstName,
          },
        ];

  const search = await hubspotFetch<HubSpotSearchResponse>(
    "/crm/v3/objects/contacts/search",
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: [
          "firstname",
          "lastname",
          "email",
          "jobtitle",
          "company",
        ],
        limit: 5,
      }),
    },
  );

  if (search.results.length === 0) {
    throw new Error(`No HubSpot contact matching "${contactName}"`);
  }

  if (search.results.length > 1 && lastName.length === 0) {
    const contexts = await Promise.all(
      search.results.map((contact) => buildContactContext(contact)),
    );
    return contexts;
  }

  return buildContactContext(search.results[0]);
}

async function buildContactContext(contact: {
  id: string;
  properties: Record<string, string | null>;
}): Promise<HubSpotContactContext> {
  const props = contact.properties;
  const email = props.email?.trim();

  if (!email) {
    throw new Error(
      `Contact ${props.firstname ?? ""} ${props.lastname ?? ""} has no email in HubSpot`,
    );
  }

  const dealAssociations = await hubspotFetch<HubSpotAssociationResponse>(
    `/crm/v4/objects/contacts/${contact.id}/associations/deals`,
  );

  if (dealAssociations.results.length === 0) {
    throw new Error(
      `Contact ${props.firstname ?? ""} ${props.lastname ?? ""} has no associated deals`,
    );
  }

  const dealId = dealAssociations.results[0].toObjectId;
  const deal = await hubspotFetch<{
    properties: Record<string, string | null>;
  }>(`/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,lead_source`);

  const companyAssociations = await hubspotFetch<HubSpotAssociationResponse>(
    `/crm/v4/objects/contacts/${contact.id}/associations/companies`,
  );

  let companyName = props.company?.trim() ?? "";

  if (companyAssociations.results.length > 0) {
    const companyId = companyAssociations.results[0].toObjectId;
    const company = await hubspotFetch<{
      properties: Record<string, string | null>;
    }>(`/crm/v3/objects/companies/${companyId}?properties=name`);

    companyName = company.properties.name?.trim() ?? companyName;
  }

  const stageLabels = await getStageLabels();
  const dealStageId = deal.properties.dealstage ?? "";
  const dealStage = stageLabels.get(dealStageId) ?? dealStageId;

  const firstName = props.firstname?.trim() ?? "";
  const lastName = props.lastname?.trim() ?? "";

  return {
    contactId: contact.id,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email,
    jobTitle: props.jobtitle?.trim() ?? "",
    companyName,
    dealId,
    dealName: deal.properties.dealname?.trim() ?? "",
    dealStage,
    leadSource: deal.properties.lead_source?.trim() ?? "the event",
  };
}

export function toTemplateContext(
  context: HubSpotContactContext,
): Record<string, string> {
  return {
    first_name: context.firstName || context.fullName,
    last_name: context.lastName,
    full_name: context.fullName,
    email: context.email,
    job_title: context.jobTitle,
    company_name: context.companyName,
    deal_name: context.dealName,
    deal_stage: context.dealStage,
    event: context.leadSource,
    lead_source: context.leadSource,
    sender_name: process.env.SENDER_NAME ?? "Abhilasha Juneja",
  };
}
