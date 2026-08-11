import {
  appendDatedNote,
  companyActivityDateProperty,
  companyNotesProperty,
  contactNotesProperty,
} from "../lib/noteProperties.js";

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
let lifecycleStageCache: Map<string, string> | null = null;

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

/** Map lifecycle stage label (lowercase) → HubSpot internal value for companies. */
export async function getCompanyLifecycleStageMap(): Promise<
  Map<string, string>
> {
  if (lifecycleStageCache) {
    return lifecycleStageCache;
  }

  const data = await hubspotFetch<{
    options?: Array<{ label: string; value: string }>;
  }>("/crm/v3/properties/companies/lifecyclestage");

  lifecycleStageCache = new Map(
    (data.options ?? []).map((option) => [
      option.label.toLowerCase(),
      option.value,
    ]),
  );

  return lifecycleStageCache;
}

export type CompanyLifecycleMatch = {
  id: string;
  name: string;
  domain: string;
  lifecycleStage: string;
};

/** List HubSpot companies whose lifecycle stage matches the given label. */
export async function listCompaniesByLifecycleStage(
  stageLabel: string,
  maxResults = 50,
): Promise<CompanyLifecycleMatch[]> {
  const label = stageLabel.trim();
  if (!label) {
    return [];
  }

  const stageMap = await getCompanyLifecycleStageMap();
  const stageValue =
    stageMap.get(label.toLowerCase()) ??
    [...stageMap.entries()].find(([key]) =>
      key.includes(label.toLowerCase()),
    )?.[1];

  if (!stageValue) {
    const valid = [...stageMap.keys()].join(", ");
    throw new Error(
      `"${stageLabel}" is not a valid company lifecycle stage. Valid options: ${valid}.`,
    );
  }

  const results = await searchObjects("companies", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "lifecyclestage",
            operator: "EQ",
            value: stageValue,
          },
        ],
      },
    ],
    properties: ["name", "domain", "lifecyclestage"],
    sorts: [{ propertyName: "name", direction: "ASCENDING" }],
  });

  return results.slice(0, maxResults).map((company) => ({
    id: company.id,
    name: company.properties.name?.trim() || "Untitled company",
    domain: company.properties.domain?.trim() ?? "",
    lifecycleStage:
      company.properties.lifecyclestage?.trim() || stageLabel,
  }));
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

/** Update a deal's pipeline stage by internal stage id. */
export async function updateDealStage(
  dealId: string,
  stageId: string,
): Promise<void> {
  await updateObjectProperties("deals", dealId, { dealstage: stageId });
}

export type NoteEngagement = {
  id: string;
  body: string;
  timestampMs: number | null;
};

function stripHtml(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch the most recent native HubSpot note engagements associated with a
 * record. These are the notes the CEO's Codex/HubSpot-MCP session writes, so
 * reading them keeps the Slack bot's view consistent with that surface.
 */
export async function getRecentNotes(
  objectType: "contacts" | "companies" | "deals",
  id: string,
  limit = 5,
): Promise<NoteEngagement[]> {
  const associations = await hubspotFetch<HubSpotAssociationResponse>(
    `/crm/v4/objects/${objectType}/${id}/associations/notes`,
  ).catch(() => ({ results: [] }) as HubSpotAssociationResponse);

  const noteIds = associations.results.map((r) => r.toObjectId);
  if (noteIds.length === 0) {
    return [];
  }

  const notes: NoteEngagement[] = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const chunk = noteIds.slice(i, i + 100);
    const data = await hubspotFetch<{
      results: Array<{ id: string; properties: Record<string, string | null> }>;
    }>("/crm/v3/objects/notes/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["hs_note_body", "hs_timestamp"],
        inputs: chunk.map((noteId) => ({ id: noteId })),
      }),
    });

    for (const note of data.results) {
      const rawTimestamp = note.properties.hs_timestamp;
      const timestampMs = rawTimestamp
        ? Number.isFinite(Number(rawTimestamp))
          ? Number(rawTimestamp)
          : Date.parse(rawTimestamp) || null
        : null;
      notes.push({
        id: note.id,
        body: stripHtml(note.properties.hs_note_body),
        timestampMs,
      });
    }
  }

  return notes
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .slice(0, limit);
}

/** Latest native note timestamp (ms) for a record, or null. */
export async function latestNoteTimestampMs(
  objectType: "contacts" | "companies" | "deals",
  id: string,
): Promise<number | null> {
  const notes = await getRecentNotes(objectType, id, 1).catch(() => []);
  return notes[0]?.timestampMs ?? null;
}

/** Return the company associated with a contact, if any. */
export async function getAssociatedCompany(
  contactId: string,
): Promise<{ id: string; name: string } | null> {
  const associations = await hubspotFetch<HubSpotAssociationResponse>(
    `/crm/v4/objects/contacts/${contactId}/associations/companies`,
  ).catch(() => ({ results: [] }) as HubSpotAssociationResponse);

  if (associations.results.length === 0) {
    return null;
  }

  const companyId = associations.results[0].toObjectId;
  const company = await hubspotFetch<{
    properties: Record<string, string | null>;
  }>(`/crm/v3/objects/companies/${companyId}?properties=name`);

  return {
    id: companyId,
    name: company.properties.name?.trim() || "Untitled company",
  };
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

export type CompanyStatusDeal = {
  id: string;
  name: string;
  stage: string;
  amount: string | null;
  closeDate: string | null;
};

export type CompanyStatusContact = {
  id: string;
  name: string;
  email: string;
  jobTitle: string;
  leadStatus: string;
};

export type CompanyStatus = {
  id: string;
  name: string;
  domain: string;
  notes: string;
  activityDate: string | null;
  nativeNotes: NoteEngagement[];
  lastActivity: string | null;
  deals: CompanyStatusDeal[];
  contacts: CompanyStatusContact[];
};

export async function findCompaniesByName(
  companyName: string,
): Promise<Array<{ id: string; name: string; domain: string }>> {
  const query = companyName.trim();
  if (!query) {
    return [];
  }

  // CONTAINS_TOKEN rejects tokens shorter than 3 chars and treats punctuation
  // as separators — "Programmers.ai" becomes ["Programmers", "ai"] and can 400.
  const tokenQuery = query
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .join(" ");

  const looksLikeDomain =
    /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(query) ||
    query.toLowerCase().includes(".ai") ||
    query.toLowerCase().includes(".com") ||
    query.toLowerCase().includes(".io");

  const domainCandidate = looksLikeDomain
    ? query.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    : null;

  const filterGroups: Array<{
    filters: Array<{ propertyName: string; operator: string; value: string }>;
  }> = [];

  if (tokenQuery) {
    filterGroups.push({
      filters: [
        {
          propertyName: "name",
          operator: "CONTAINS_TOKEN",
          value: tokenQuery,
        },
      ],
    });
  }

  // Exact name match (case-insensitive via EQ on the raw string when possible).
  filterGroups.push({
    filters: [
      {
        propertyName: "name",
        operator: "EQ",
        value: query,
      },
    ],
  });

  if (domainCandidate) {
    filterGroups.push({
      filters: [
        {
          propertyName: "domain",
          operator: "EQ",
          value: domainCandidate,
        },
      ],
    });
    // Also try without a leading www.
    const bare = domainCandidate.replace(/^www\./, "");
    if (bare !== domainCandidate) {
      filterGroups.push({
        filters: [
          {
            propertyName: "domain",
            operator: "EQ",
            value: bare,
          },
        ],
      });
    }
  }

  // First meaningful token alone (e.g. "Programmers" from "Programmers.ai").
  const firstToken = tokenQuery.split(/\s+/)[0];
  if (firstToken && firstToken.toLowerCase() !== tokenQuery.toLowerCase()) {
    filterGroups.push({
      filters: [
        {
          propertyName: "name",
          operator: "CONTAINS_TOKEN",
          value: firstToken,
        },
      ],
    });
  }

  if (filterGroups.length === 0) {
    return [];
  }

  let results: HubSpotSearchResult[] = [];
  try {
    const search = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/companies/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: filterGroups.slice(0, 5), // HubSpot max 5 groups
          properties: ["name", "domain"],
          limit: 10,
        }),
      },
    );
    results = search.results;
  } catch (error) {
    // Fall back to a safer single-token search if the combined query fails.
    if (!firstToken) {
      throw error;
    }
    const search = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/companies/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "name",
                  operator: "CONTAINS_TOKEN",
                  value: firstToken,
                },
              ],
            },
            ...(domainCandidate
              ? [
                  {
                    filters: [
                      {
                        propertyName: "domain",
                        operator: "EQ",
                        value: domainCandidate,
                      },
                    ],
                  },
                ]
              : []),
          ],
          properties: ["name", "domain"],
          limit: 10,
        }),
      },
    );
    results = search.results;
  }

  const mapped = results.map((company) => ({
    id: company.id,
    name: company.properties.name?.trim() || "Untitled company",
    domain: company.properties.domain?.trim() ?? "",
  }));

  // Prefer exact name / domain matches, then prefix matches.
  const needle = query.toLowerCase();
  const domainNeedle = domainCandidate?.toLowerCase();
  mapped.sort((a, b) => {
    const score = (c: { name: string; domain: string }) => {
      const name = c.name.toLowerCase();
      const domain = c.domain.toLowerCase();
      if (name === needle) return 0;
      if (domainNeedle && domain === domainNeedle) return 1;
      if (name.startsWith(needle) || name.includes(needle)) return 2;
      if (domainNeedle && domain.includes(domainNeedle.split(".")[0] ?? "")) {
        return 3;
      }
      return 4;
    };
    return score(a) - score(b);
  });

  // Dedupe by id and cap.
  const seen = new Set<string>();
  const unique: typeof mapped = [];
  for (const c of mapped) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
    if (unique.length >= 5) break;
  }
  return unique;
}

export async function findContactByEmail(
  email: string,
): Promise<{ id: string; name: string } | null> {
  const query = email.trim().toLowerCase();
  if (!query) {
    return null;
  }

  const search = await hubspotFetch<HubSpotSearchResponse>(
    "/crm/v3/objects/contacts/search",
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          { filters: [{ propertyName: "email", operator: "EQ", value: query }] },
        ],
        properties: ["firstname", "lastname", "email"],
        limit: 1,
      }),
    },
  );

  const contact = search.results[0];
  if (!contact) {
    return null;
  }
  const first = contact.properties.firstname?.trim() ?? "";
  const last = contact.properties.lastname?.trim() ?? "";
  return {
    id: contact.id,
    name:
      `${first} ${last}`.trim() ||
      contact.properties.email?.trim() ||
      "Unknown contact",
  };
}

export async function findCompanyByDomain(
  domain: string,
): Promise<{ id: string; name: string } | null> {
  const query = domain.trim().toLowerCase();
  if (!query) {
    return null;
  }

  const search = await hubspotFetch<HubSpotSearchResponse>(
    "/crm/v3/objects/companies/search",
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: "domain", operator: "EQ", value: query },
            ],
          },
        ],
        properties: ["name", "domain"],
        limit: 1,
      }),
    },
  );

  const company = search.results[0];
  if (!company) {
    return null;
  }
  return {
    id: company.id,
    name: company.properties.name?.trim() || "Untitled company",
  };
}

export async function findContactsByName(
  name: string,
): Promise<Array<{ id: string; name: string; email: string; company: string }>> {
  const query = name.trim();
  if (!query) {
    return [];
  }

  const { firstName, lastName } = parseContactName(query);
  const filters =
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

  const search = await hubspotFetch<HubSpotSearchResponse>(
    "/crm/v3/objects/contacts/search",
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: ["firstname", "lastname", "email", "company"],
        limit: 5,
      }),
    },
  );

  return search.results.map((contact) => {
    const first = contact.properties.firstname?.trim() ?? "";
    const last = contact.properties.lastname?.trim() ?? "";
    return {
      id: contact.id,
      name: `${first} ${last}`.trim() || "Unknown contact",
      email: contact.properties.email?.trim() ?? "",
      company: contact.properties.company?.trim() ?? "",
    };
  });
}

export async function getCompanyStatus(
  companyId: string,
): Promise<CompanyStatus> {
  const notesProp = companyNotesProperty();
  const activityProp = companyActivityDateProperty();

  const company = await hubspotFetch<{
    id: string;
    properties: Record<string, string | null>;
  }>(
    `/crm/v3/objects/companies/${companyId}?properties=name,domain,${encodeURIComponent(notesProp)},${encodeURIComponent(activityProp)}`,
  );

  const [dealAssociations, contactAssociations, nativeNotes] =
    await Promise.all([
      hubspotFetch<HubSpotAssociationResponse>(
        `/crm/v4/objects/companies/${companyId}/associations/deals`,
      ),
      hubspotFetch<HubSpotAssociationResponse>(
        `/crm/v4/objects/companies/${companyId}/associations/contacts`,
      ),
      getRecentNotes("companies", companyId).catch(() => []),
    ]);

  const dealIds = dealAssociations.results.map((r) => r.toObjectId);
  const contactIds = contactAssociations.results.map((r) => r.toObjectId);
  const stageLabels = await getStageLabels().catch(() => new Map());

  const deals: CompanyStatusDeal[] = [];
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    if (chunk.length === 0) {
      break;
    }
    const data = await hubspotFetch<{
      results: Array<{ id: string; properties: Record<string, string | null> }>;
    }>("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["dealname", "dealstage", "amount", "closedate"],
        inputs: chunk.map((id) => ({ id })),
      }),
    });

    for (const deal of data.results) {
      const stageId = deal.properties.dealstage ?? "";
      deals.push({
        id: deal.id,
        name: deal.properties.dealname?.trim() || "Untitled deal",
        stage: stageLabels.get(stageId) || stageId || "—",
        amount: deal.properties.amount?.trim() || null,
        closeDate: deal.properties.closedate?.trim() || null,
      });
    }
  }

  const contacts: CompanyStatusContact[] = [];
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    if (chunk.length === 0) {
      break;
    }
    const data = await hubspotFetch<{
      results: Array<{ id: string; properties: Record<string, string | null> }>;
    }>("/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: [
          "firstname",
          "lastname",
          "email",
          "jobtitle",
          "hs_lead_status",
        ],
        inputs: chunk.map((id) => ({ id })),
      }),
    });

    for (const contact of data.results) {
      const first = contact.properties.firstname?.trim() ?? "";
      const last = contact.properties.lastname?.trim() ?? "";
      contacts.push({
        id: contact.id,
        name: `${first} ${last}`.trim() || "Unknown contact",
        email: contact.properties.email?.trim() ?? "",
        jobTitle: contact.properties.jobtitle?.trim() ?? "",
        leadStatus: contact.properties.hs_lead_status?.trim() ?? "",
      });
    }
  }

  const customActivityDate = company.properties[activityProp]?.trim() || null;
  const latestNativeNoteMs = nativeNotes[0]?.timestampMs ?? null;
  const customActivityMs = customActivityDate
    ? Date.parse(customActivityDate) || null
    : null;

  const lastActivityMs = Math.max(
    latestNativeNoteMs ?? 0,
    customActivityMs ?? 0,
  );
  const lastActivity =
    lastActivityMs > 0
      ? new Date(lastActivityMs).toISOString().slice(0, 10)
      : customActivityDate;

  return {
    id: company.id,
    name: company.properties.name?.trim() || "Untitled company",
    domain: company.properties.domain?.trim() ?? "",
    notes: company.properties[notesProp]?.trim() ?? "",
    activityDate: customActivityDate,
    nativeNotes,
    lastActivity,
    deals,
    contacts,
  };
}

export async function createCrmObject(
  objectType: "contacts" | "companies" | "deals",
  properties: Record<string, string>,
): Promise<{ id: string }> {
  const data = await hubspotFetch<{ id: string }>(
    `/crm/v3/objects/${objectType}`,
    {
      method: "POST",
      body: JSON.stringify({ properties }),
    },
  );
  return { id: data.id };
}

export async function associateDefault(
  fromType: "contacts" | "companies" | "deals",
  fromId: string,
  toType: "contacts" | "companies" | "deals",
  toId: string,
): Promise<void> {
  await hubspotFetch(
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
    { method: "PUT" },
  );
}

const RECORD_OBJECT_TYPE: Record<
  NoteRecordType,
  "contacts" | "companies" | "deals"
> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};

/** Create a HubSpot task (engagement) due at dueMs, optionally owned. */
export async function createTask(opts: {
  subject: string;
  dueMs: number;
  body?: string;
  ownerId?: string;
}): Promise<{ id: string }> {
  const properties: Record<string, string> = {
    hs_task_subject: opts.subject,
    hs_timestamp: String(opts.dueMs),
    hs_task_status: "NOT_STARTED",
    hs_task_type: "TODO",
    ...(opts.body ? { hs_task_body: opts.body } : {}),
    ...(opts.ownerId ? { hubspot_owner_id: opts.ownerId } : {}),
  };

  const data = await hubspotFetch<{ id: string }>("/crm/v3/objects/tasks", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
  return { id: data.id };
}

/** Associate a task with a contact, company, or deal using the default type. */
export async function associateTaskToRecord(
  taskId: string,
  recordType: NoteRecordType,
  recordId: string,
): Promise<void> {
  const toType = RECORD_OBJECT_TYPE[recordType];
  await hubspotFetch(
    `/crm/v4/objects/tasks/${taskId}/associations/default/${toType}/${recordId}`,
    { method: "PUT" },
  );
}

export type CreateProspectInput = {
  firstName: string;
  lastName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  source?: string;
  notes?: string;
  linkedin?: string;
};

export type CreateProspectResult = {
  contactId: string;
  dealId: string;
  companyId: string | null;
  contactName: string;
  dealName: string;
  companyName: string | null;
  stageLabel: string;
};

export type CreateContactResult = {
  contactId: string;
  companyId: string | null;
  contactName: string;
  companyName: string | null;
};

/** Canonical deal name for FlairX pipeline deals. */
export function formatCompanyDealName(companyName: string): string {
  const name = companyName.trim();
  return name ? `${name} - FlairX` : "FlairX";
}

/** Create a HubSpot contact and optionally a linked company record. No deal. */
export async function createContact(
  input: CreateProspectInput,
): Promise<CreateContactResult> {
  const contactName = `${input.firstName} ${input.lastName}`.trim();

  if (input.email?.trim()) {
    const existing = await findContactByEmail(input.email);
    if (existing) {
      throw new Error(
        `Contact already exists: ${existing.name} <${input.email.trim()}>. Not creating a duplicate.`,
      );
    }
  }

  let notes = input.notes?.trim() ?? "";
  if (input.source?.trim()) {
    const sourceLine = `Source: ${input.source.trim()}`;
    notes = notes ? `${notes}\n${sourceLine}` : sourceLine;
  }

  const contactProperties: Record<string, string> = {
    firstname: input.firstName,
    ...(input.lastName ? { lastname: input.lastName } : {}),
    ...(input.companyName ? { company: input.companyName } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.mobile ? { mobilephone: input.mobile } : {}),
    ...(input.title ? { jobtitle: input.title } : {}),
    ...(input.linkedin ? { hs_linkedin_url: input.linkedin } : {}),
  };

  if (notes) {
    contactProperties[contactNotesProperty()] = appendDatedNote("", notes);
  }

  const contact = await createCrmObject("contacts", contactProperties);

  let companyId: string | null = null;
  if (input.companyName) {
    const existing = await findCompaniesByName(input.companyName);
    const exact = existing.find(
      (c) => c.name.toLowerCase() === input.companyName!.toLowerCase(),
    );
    if (exact) {
      companyId = exact.id;
    } else {
      const company = await createCrmObject("companies", {
        name: input.companyName,
      });
      companyId = company.id;
    }
    await associateDefault("contacts", contact.id, "companies", companyId);
  }

  return {
    contactId: contact.id,
    companyId,
    contactName,
    companyName: input.companyName ?? null,
  };
}

export async function createProspect(
  input: CreateProspectInput,
): Promise<CreateProspectResult> {
  const pipeline = await getPipelineMeta();
  const prospecting =
    pipeline.stageByLabel.get("prospecting") ?? pipeline.stages[0];

  if (!prospecting) {
    throw new Error("No Prospecting stage found in HubSpot deal pipeline");
  }

  // Resolve company first so we can refuse a duplicate FlairX deal before
  // creating the contact.
  if (input.companyName) {
    const existing = await findCompaniesByName(input.companyName);
    const exact = existing.find(
      (c) => c.name.toLowerCase() === input.companyName!.toLowerCase(),
    );
    if (exact) {
      const status = await getCompanyStatus(exact.id);
      if (status.deals.length > 0) {
        const existingDeals = status.deals
          .map((d) => `"${d.name}" (${d.stage})`)
          .join(", ");
        throw new Error(
          `${exact.name} already has deal(s): ${existingDeals}. Not creating a duplicate deal. Add the contact with add_contact instead, or use the existing deal.`,
        );
      }
    }
  }

  const { contactId, companyId, contactName, companyName } =
    await createContact(input);

  const dealName = companyName
    ? formatCompanyDealName(companyName)
    : formatCompanyDealName(contactName);

  const dealProperties: Record<string, string> = {
    dealname: dealName,
    dealstage: prospecting.id,
    pipeline: pipeline.id,
    ...(input.source ? { lead_source: input.source } : {}),
  };

  const deal = await createCrmObject("deals", dealProperties);

  await associateDefault("contacts", contactId, "deals", deal.id);
  if (companyId) {
    await associateDefault("companies", companyId, "deals", deal.id);
  }

  return {
    contactId,
    dealId: deal.id,
    companyId,
    contactName,
    dealName,
    companyName,
    stageLabel: prospecting.label,
  };
}

export type CreateCompanyDealInput = {
  companyId: string;
  companyName: string;
  contactIds: string[];
  /** Pipeline stage label; defaults to Prospecting. */
  stageLabel?: string;
  /** When true, create even if the company already has deals. */
  force?: boolean;
};

export type CreateCompanyDealResult = {
  dealId: string;
  dealName: string;
  companyId: string;
  companyName: string;
  stageLabel: string;
  associatedContactIds: string[];
};

/**
 * Create a deal on an existing company, named "[Company] - FlairX", and
 * associate the company plus every provided contact.
 * Refuses if the company already has deals unless `force` is set.
 */
export async function createDealForCompany(
  input: CreateCompanyDealInput,
): Promise<CreateCompanyDealResult> {
  const pipeline = await getPipelineMeta();
  const stageLabel = (input.stageLabel ?? "Prospecting").trim();
  const stage =
    pipeline.stageByLabel.get(stageLabel.toLowerCase()) ??
    pipeline.stageByLabel.get("prospecting") ??
    pipeline.stages[0];

  if (!stage) {
    throw new Error("No deal pipeline stages found in HubSpot");
  }

  const dealName = formatCompanyDealName(input.companyName);

  if (!input.force) {
    const status = await getCompanyStatus(input.companyId);
    if (status.deals.length > 0) {
      const existing = status.deals
        .map((d) => `"${d.name}" (${d.stage})`)
        .join(", ");
      throw new Error(
        `${input.companyName} already has deal(s): ${existing}. Not creating a duplicate.`,
      );
    }
  }

  const deal = await createCrmObject("deals", {
    dealname: dealName,
    dealstage: stage.id,
    pipeline: pipeline.id,
  });

  await associateDefault("companies", input.companyId, "deals", deal.id);

  for (const contactId of input.contactIds) {
    await associateDefault("contacts", contactId, "deals", deal.id);
  }

  return {
    dealId: deal.id,
    dealName,
    companyId: input.companyId,
    companyName: input.companyName,
    stageLabel: stage.label,
    associatedContactIds: [...input.contactIds],
  };
}

export type DealForStageMove = {
  id: string;
  name: string;
  currentStageId: string;
  currentStageLabel: string;
};

/**
 * Resolve candidate deals for a stage move, by company name and/or deal name.
 * Returns ambiguous company matches so the caller can ask for clarification.
 */
export async function resolveDealsForStageMove(opts: {
  companyName?: string;
  dealName?: string;
}): Promise<{
  ambiguousCompanies?: Array<{ id: string; name: string; domain: string }>;
  deals: DealForStageMove[];
}> {
  const stageLabels = await getStageLabels().catch(() => new Map());
  const toDeal = (
    id: string,
    name: string,
    stageId: string,
  ): DealForStageMove => ({
    id,
    name,
    currentStageId: stageId,
    currentStageLabel: stageLabels.get(stageId) || stageId || "—",
  });

  if (opts.companyName) {
    const companies = await findCompaniesByName(opts.companyName);
    if (companies.length === 0) {
      return { deals: [] };
    }
    if (companies.length > 1) {
      return { ambiguousCompanies: companies, deals: [] };
    }

    const status = await getCompanyStatus(companies[0].id);
    let deals = status.deals.map((deal) =>
      toDeal(
        deal.id,
        deal.name,
        // getCompanyStatus already resolved stage to a label; re-resolve id
        [...stageLabels.entries()].find(([, label]) => label === deal.stage)?.[0] ??
          deal.stage,
      ),
    );

    if (opts.dealName) {
      const needle = opts.dealName.toLowerCase();
      deals = deals.filter((deal) =>
        deal.name.toLowerCase().includes(needle),
      );
    }

    return { deals };
  }

  if (opts.dealName) {
    const search = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/deals/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "dealname",
                  operator: "CONTAINS_TOKEN",
                  value: opts.dealName,
                },
              ],
            },
          ],
          properties: ["dealname", "dealstage"],
          limit: 10,
        }),
      },
    );

    return {
      deals: search.results.map((deal) =>
        toDeal(
          deal.id,
          deal.properties.dealname?.trim() || "Untitled deal",
          deal.properties.dealstage ?? "",
        ),
      ),
    };
  }

  return { deals: [] };
}

export { parseContactName };
