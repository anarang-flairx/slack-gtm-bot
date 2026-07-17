const HUBSPOT_BASE = "https://api.hubapi.com";

function getToken(): string {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_ACCESS_TOKEN in .env");
  }
  return token;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function hubspotFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const retries = [1000, 4000, 10000];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries.length; attempt++) {
    const response = await fetch(`${HUBSPOT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (response.status === 429 && attempt < retries.length) {
      await sleep(retries[attempt]);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`HubSpot API error ${response.status}: ${text}`);
      throw lastError;
    }

    return response.json() as Promise<T>;
  }

  throw lastError ?? new Error("HubSpot request failed after retries");
}

export type HubSpotSearchResult = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
};

type HubSpotSearchResponse = {
  results: HubSpotSearchResult[];
  paging?: { next?: { after: string } };
};

type HubSpotAssociationResponse = {
  results: Array<{ toObjectId: string }>;
};

export type PipelineStage = {
  id: string;
  label: string;
  displayOrder: number;
  probability: number;
};

export type PipelineMeta = {
  id: string;
  stages: PipelineStage[];
  stageById: Map<string, PipelineStage>;
  stageByLabel: Map<string, PipelineStage>;
};

type HubSpotPipelinesResponse = {
  results: Array<{
    id: string;
    stages: Array<{
      id: string;
      label: string;
      displayOrder: number;
      metadata?: { probability?: string };
    }>;
  }>;
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

let pipelineCache: PipelineMeta | null = null;
let leadStatusCache: Map<string, string> | null = null;

export async function getPipelineMeta(): Promise<PipelineMeta> {
  if (pipelineCache) {
    return pipelineCache;
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

  const stages: PipelineStage[] = pipeline.stages
    .map((stage) => ({
      id: stage.id,
      label: stage.label,
      displayOrder: stage.displayOrder,
      probability: Number(stage.metadata?.probability ?? 0),
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  pipelineCache = {
    id: pipeline.id,
    stages,
    stageById: new Map(stages.map((s) => [s.id, s])),
    stageByLabel: new Map(stages.map((s) => [s.label.toLowerCase(), s])),
  };

  return pipelineCache;
}

async function getStageLabels(): Promise<Map<string, string>> {
  const pipeline = await getPipelineMeta();
  return new Map(
    pipeline.stages.map((stage) => [stage.id, stage.label]),
  );
}

export async function getLeadStatusMap(): Promise<Map<string, string>> {
  if (leadStatusCache) {
    return leadStatusCache;
  }

  const data = await hubspotFetch<{
    options?: Array<{ label: string; value: string }>;
  }>("/crm/v3/properties/contacts/hs_lead_status");

  leadStatusCache = new Map(
    (data.options ?? []).map((option) => [
      option.label.toLowerCase(),
      option.value,
    ]),
  );

  return leadStatusCache;
}

export async function searchObjects(
  objectType: "contacts" | "deals" | "tasks" | "companies",
  body: Record<string, unknown>,
): Promise<HubSpotSearchResult[]> {
  const results: HubSpotSearchResult[] = [];
  let after: string | undefined;

  do {
    const payload = {
      ...body,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const page = await hubspotFetch<HubSpotSearchResponse>(
      `/crm/v3/objects/${objectType}/search`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    results.push(...page.results);
    after = page.paging?.next?.after;
  } while (after);

  return results;
}

export async function batchReadCompanies(
  ids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }

  const uniqueIds = [...new Set(ids)];

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    const data = await hubspotFetch<{
      results: Array<{ id: string; properties: { name?: string | null } }>;
    }>("/crm/v3/objects/companies/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["name"],
        inputs: chunk.map((id) => ({ id })),
      }),
    });

    for (const company of data.results) {
      names.set(company.id, company.properties.name?.trim() ?? "");
    }
  }

  return names;
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

  if (search.results.length > 1) {
    const contexts = await Promise.all(
      search.results.map((contact) => buildContactContext(contact)),
    );
    return contexts;
  }

  return buildContactContext(search.results[0]);
}

export async function getContactContextById(
  contactId: string,
): Promise<HubSpotContactContext> {
  const contact = await hubspotFetch<HubSpotSearchResult>(
    `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,jobtitle,company`,
  );

  return buildContactContext(contact, { allowMissingEvent: true });
}

async function buildContactContext(
  contact: {
    id: string;
    properties: Record<string, string | null>;
  },
  options?: { allowMissingEvent?: boolean },
): Promise<HubSpotContactContext> {
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

  let dealId = "";
  let dealName = "";
  let dealStage = "";
  let leadSource = "";

  if (dealAssociations.results.length > 0) {
    dealId = dealAssociations.results[0].toObjectId;
    const deal = await hubspotFetch<{
      properties: Record<string, string | null>;
    }>(
      `/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,lead_source`,
    );

    const stageLabels = await getStageLabels();
    const dealStageId = deal.properties.dealstage ?? "";
    dealName = deal.properties.dealname?.trim() ?? "";
    dealStage = stageLabels.get(dealStageId) ?? dealStageId;
    leadSource = deal.properties.lead_source?.trim() ?? "";
  } else if (!options?.allowMissingEvent) {
    throw new Error(
      `Contact ${props.firstname ?? ""} ${props.lastname ?? ""} has no associated deals`,
    );
  }

  if (!leadSource) {
    leadSource = options?.allowMissingEvent ? "⟨event⟩" : "the event";
  }

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
    dealName,
    dealStage,
    leadSource,
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

export type NoteRecordType = "deal" | "contact" | "company";

export type NoteRecordMatch = {
  type: NoteRecordType;
  id: string;
  name: string;
  detail: string;
};

export async function getObjectProperties(
  objectType: "contacts" | "companies" | "deals",
  id: string,
  properties: string[],
): Promise<Record<string, string | null>> {
  const qs = properties.map(encodeURIComponent).join(",");
  const data = await hubspotFetch<{
    properties: Record<string, string | null>;
  }>(`/crm/v3/objects/${objectType}/${id}?properties=${qs}`);
  return data.properties;
}

export async function updateObjectProperties(
  objectType: "contacts" | "companies" | "deals",
  id: string,
  properties: Record<string, string>,
): Promise<void> {
  await hubspotFetch(`/crm/v3/objects/${objectType}/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function searchNoteMatchesByName(
  name: string,
): Promise<NoteRecordMatch[]> {
  const query = name.trim();
  if (!query) {
    return [];
  }

  const { firstName, lastName } = parseContactName(query);
  const matches: NoteRecordMatch[] = [];

  const contactFilters =
    lastName.length > 0
      ? [
          { propertyName: "firstname", operator: "EQ", value: firstName },
          { propertyName: "lastname", operator: "EQ", value: lastName },
        ]
      : [
          {
            propertyName: "firstname",
            operator: "CONTAINS_TOKEN",
            value: firstName,
          },
        ];

  const [contacts, deals, companies] = await Promise.all([
    hubspotFetch<HubSpotSearchResponse>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: contactFilters }],
        properties: ["firstname", "lastname", "email", "company"],
        limit: 5,
      }),
    }),
    hubspotFetch<HubSpotSearchResponse>("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "dealname",
                operator: "CONTAINS_TOKEN",
                value: query,
              },
            ],
          },
        ],
        properties: ["dealname", "dealstage"],
        limit: 5,
      }),
    }),
    hubspotFetch<HubSpotSearchResponse>("/crm/v3/objects/companies/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "name",
                operator: "CONTAINS_TOKEN",
                value: query,
              },
            ],
          },
        ],
        properties: ["name", "domain"],
        limit: 5,
      }),
    }),
  ]);

  for (const contact of contacts.results) {
    const first = contact.properties.firstname?.trim() ?? "";
    const last = contact.properties.lastname?.trim() ?? "";
    const fullName = `${first} ${last}`.trim() || "Unknown contact";
    const email = contact.properties.email?.trim() ?? "";
    const company = contact.properties.company?.trim() ?? "";
    matches.push({
      type: "contact",
      id: contact.id,
      name: fullName,
      detail: [email, company].filter(Boolean).join(" · ") || "Contact",
    });
  }

  const stageLabels = await getStageLabels().catch(() => new Map());
  for (const deal of deals.results) {
    const dealName = deal.properties.dealname?.trim() || "Untitled deal";
    const stageId = deal.properties.dealstage ?? "";
    matches.push({
      type: "deal",
      id: deal.id,
      name: dealName,
      detail: stageLabels.get(stageId) || stageId || "Deal",
    });
  }

  for (const company of companies.results) {
    const companyName = company.properties.name?.trim() || "Untitled company";
    const domain = company.properties.domain?.trim() ?? "";
    matches.push({
      type: "company",
      id: company.id,
      name: companyName,
      detail: domain || "Company",
    });
  }

  return matches;
}

export async function findNoteRecords(
  name: string,
): Promise<NoteRecordMatch | NoteRecordMatch[]> {
  const matches = await searchNoteMatchesByName(name);
  if (matches.length === 0) {
    throw new Error(`No HubSpot contact, deal, or company matching "${name}"`);
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return matches;
}
