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

    if (
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    ) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
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
  label: string;
  stages: PipelineStage[];
  stageById: Map<string, PipelineStage>;
  stageByLabel: Map<string, PipelineStage>;
};

type HubSpotPipelinesResponse = {
  results: Array<{
    id: string;
    label: string;
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

/** HubSpot metadata refreshes every 30s so new pipelines/stages show up without restart. */
const META_CACHE_TTL_MS = 30_000;

type TimedCache<T> = { value: T; fetchedAt: number };

let pipelineCache: TimedCache<PipelineMeta> | null = null;
let pipelinesListCache: TimedCache<
  Array<{ id: string; label: string; stageCount: number }>
> | null = null;
let leadStatusCache: TimedCache<Map<string, string>> | null = null;
let lifecycleStageCache: Map<string, string> | null = null;
let lifecycleStageOptionsCache: TimedCache<
  Array<{ label: string; value: string }>
> | null = null;

function cacheFresh<T>(entry: TimedCache<T> | null): entry is TimedCache<T> {
  return !!entry && Date.now() - entry.fetchedAt < META_CACHE_TTL_MS;
}

function toPipelineMeta(
  pipeline: HubSpotPipelinesResponse["results"][number],
): PipelineMeta {
  const stages: PipelineStage[] = pipeline.stages
    .map((stage) => ({
      id: stage.id,
      label: stage.label,
      displayOrder: stage.displayOrder,
      probability: Number(stage.metadata?.probability ?? 0),
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return {
    id: pipeline.id,
    label: pipeline.label?.trim() || pipeline.id,
    stages,
    stageById: new Map(stages.map((s) => [s.id, s])),
    stageByLabel: new Map(stages.map((s) => [s.label.toLowerCase(), s])),
  };
}

async function fetchDealPipelines(): Promise<
  HubSpotPipelinesResponse["results"]
> {
  const data = await hubspotFetch<HubSpotPipelinesResponse>(
    "/crm/v3/pipelines/deals",
  );
  return data.results ?? [];
}

/** List all HubSpot deal pipelines (short TTL cache). */
export async function listDealPipelines(): Promise<
  Array<{ id: string; label: string; stageCount: number }>
> {
  if (cacheFresh(pipelinesListCache)) {
    return pipelinesListCache.value;
  }

  const results = await fetchDealPipelines();
  const list = results.map((p) => ({
    id: p.id,
    label: p.label?.trim() || p.id,
    stageCount: p.stages?.length ?? 0,
  }));
  pipelinesListCache = { value: list, fetchedAt: Date.now() };
  return list;
}

async function loadCompanyLifecycleStages(): Promise<
  Array<{ label: string; value: string }>
> {
  if (cacheFresh(lifecycleStageOptionsCache)) {
    return lifecycleStageOptionsCache.value;
  }

  const data = await hubspotFetch<{
    options?: Array<{ label: string; value: string }>;
  }>("/crm/v3/properties/companies/lifecyclestage");

  const options = (data.options ?? []).map((option) => ({
    label: option.label,
    value: option.value,
  }));
  lifecycleStageOptionsCache = { value: options, fetchedAt: Date.now() };
  lifecycleStageCache = new Map(
    options.map((option) => [option.label.toLowerCase(), option.value]),
  );

  return options;
}

/**
 * Resolve deal pipeline metadata.
 * Prefers `pipelineId`, then `HUBSPOT_PIPELINE_ID`, then the first pipeline.
 */
export async function getPipelineMeta(
  pipelineId?: string,
): Promise<PipelineMeta> {
  const wantId =
    pipelineId?.trim() || process.env.HUBSPOT_PIPELINE_ID?.trim() || "";

  if (
    cacheFresh(pipelineCache) &&
    (!wantId || pipelineCache.value.id === wantId)
  ) {
    return pipelineCache.value;
  }

  const results = await fetchDealPipelines();
  const pipeline = wantId
    ? results.find((p) => p.id === wantId)
    : results[0];

  if (!pipeline) {
    const available = results
      .map((p) => `${p.label?.trim() || p.id} (${p.id})`)
      .join(", ");
    throw new Error(
      wantId
        ? `No HubSpot deal pipeline with id "${wantId}". Available: ${available || "none"}`
        : "No HubSpot deal pipeline found",
    );
  }

  const meta = toPipelineMeta(pipeline);
  pipelineCache = { value: meta, fetchedAt: Date.now() };
  pipelinesListCache = {
    value: results.map((p) => ({
      id: p.id,
      label: p.label?.trim() || p.id,
      stageCount: p.stages?.length ?? 0,
    })),
    fetchedAt: Date.now(),
  };
  return meta;
}

async function getStageLabels(): Promise<Map<string, string>> {
  // Merge labels across all pipelines so deals in any pipeline resolve.
  const results = await fetchDealPipelines();
  const labels = new Map<string, string>();
  for (const pipeline of results) {
    for (const stage of pipeline.stages ?? []) {
      labels.set(stage.id, stage.label);
    }
  }
  return labels;
}

export async function getLeadStatusMap(): Promise<Map<string, string>> {
  if (cacheFresh(leadStatusCache)) {
    return leadStatusCache.value;
  }

  const data = await hubspotFetch<{
    options?: Array<{ label: string; value: string }>;
  }>("/crm/v3/properties/contacts/hs_lead_status");

  const map = new Map(
    (data.options ?? []).map((option) => [
      option.label.toLowerCase(),
      option.value,
    ]),
  );
  leadStatusCache = { value: map, fetchedAt: Date.now() };
  return map;
}

/** Map lifecycle stage label (lowercase) → HubSpot internal value for companies. */
export async function getCompanyLifecycleStageMap(): Promise<
  Map<string, string>
> {
  await loadCompanyLifecycleStages();
  return lifecycleStageCache!;
}

/** Ordered HubSpot company lifecycle stage options (display label + value). */
export async function getCompanyLifecycleStageOptions(): Promise<
  Array<{ label: string; value: string }>
> {
  return loadCompanyLifecycleStages();
}

/** Internal name of the company relationship-type property (Partnership pipeline). */
export function relationshipTypeProperty(): string {
  return process.env.HUBSPOT_RELATIONSHIP_TYPE_PROPERTY ?? "relationship_type";
}

/** True when the deal belongs to the Partnership pipeline (env id or label match). */
export function isPartnershipPipeline(
  pipelineId: string,
  pipelineLabel: string,
): boolean {
  const configuredId = process.env.HUBSPOT_PARTNERSHIP_PIPELINE_ID?.trim();
  if (configuredId && pipelineId === configuredId) {
    return true;
  }
  return pipelineLabel.trim().toLowerCase().includes("partnership");
}

/** Stock HubSpot Sales Pipeline stage names (not FlairX). */
const STOCK_HUBSPOT_STAGE_MARKERS = [
  "appointment scheduled",
  "qualified to buy",
  "presentation scheduled",
  "decision maker bought-in",
  "contract sent",
];

/** FlairX-style Sales stage markers. */
const FLAIRX_SALES_STAGE_MARKERS = [
  "initial contact",
  "demo scheduled",
  "demo completed",
  "proposal sent",
  "negotiation",
];

function stageLabelSet(stages: Array<{ label: string }>): Set<string> {
  return new Set(stages.map((s) => s.label.trim().toLowerCase()));
}

export function looksLikeStockHubSpotSalesStages(
  stages: Array<{ label: string }>,
): boolean {
  const labels = stageLabelSet(stages);
  return (
    STOCK_HUBSPOT_STAGE_MARKERS.filter((m) => labels.has(m)).length >= 2
  );
}

export function looksLikeFlairXSalesStages(
  stages: Array<{ label: string }>,
): boolean {
  const labels = stageLabelSet(stages);
  return FLAIRX_SALES_STAGE_MARKERS.filter((m) => labels.has(m)).length >= 2;
}

/**
 * Pipelines to offer when creating a deal: configured Sales + Partnerships
 * when env ids are set; otherwise all HubSpot deal pipelines.
 */
export async function listDealCreatePipelines(): Promise<
  Array<{ id: string; label: string; stageCount: number }>
> {
  const all = await listDealPipelines();
  const salesId = process.env.HUBSPOT_PIPELINE_ID?.trim() || "";
  const partnerId = process.env.HUBSPOT_PARTNERSHIP_PIPELINE_ID?.trim() || "";
  if (!salesId && !partnerId) {
    return all;
  }

  const preferred: Array<{ id: string; label: string; stageCount: number }> =
    [];
  const seen = new Set<string>();
  for (const id of [salesId, partnerId]) {
    if (!id || seen.has(id)) {
      continue;
    }
    const match = all.find((p) => p.id === id);
    if (match) {
      preferred.push(match);
      seen.add(id);
    }
  }
  return preferred.length > 0 ? preferred : all;
}

/**
 * If `pipelineId` is the stock HubSpot Sales pipeline, prefer another pipeline
 * that has FlairX-style stages (Initial Contact / Demo Scheduled / …).
 */
export async function preferFlairXSalesPipelineId(
  pipelineId: string,
): Promise<string> {
  const meta = await getPipelineMeta(pipelineId);
  if (!looksLikeStockHubSpotSalesStages(meta.stages)) {
    return pipelineId;
  }
  if (isPartnershipPipeline(meta.id, meta.label)) {
    return pipelineId;
  }

  const all = await fetchDealPipelines();
  const partnerId = process.env.HUBSPOT_PARTNERSHIP_PIPELINE_ID?.trim() || "";
  for (const candidate of all) {
    if (candidate.id === pipelineId) {
      continue;
    }
    if (partnerId && candidate.id === partnerId) {
      continue;
    }
    if (isPartnershipPipeline(candidate.id, candidate.label?.trim() || "")) {
      continue;
    }
    const candidateMeta = toPipelineMeta(candidate);
    if (looksLikeFlairXSalesStages(candidateMeta.stages)) {
      console.warn(
        `[pipeline] "${pipelineId}" has HubSpot stock Sales stages; using "${candidateMeta.label}" (${candidateMeta.id}) for Sales instead.`,
      );
      return candidateMeta.id;
    }
  }
  return pipelineId;
}

let relationshipTypeOptionsCache: TimedCache<
  Array<{ label: string; value: string }>
> | null = null;

/** Options for the company relationship-type property (Partnership pipeline). */
export async function getRelationshipTypeOptions(): Promise<
  Array<{ label: string; value: string }>
> {
  if (cacheFresh(relationshipTypeOptionsCache)) {
    return relationshipTypeOptionsCache.value;
  }

  const prop = relationshipTypeProperty();
  const data = await hubspotFetch<{
    options?: Array<{ label: string; value: string }>;
  }>(`/crm/v3/properties/companies/${encodeURIComponent(prop)}`);

  const options = (data.options ?? []).map((option) => ({
    label: option.label,
    value: option.value,
  }));
  relationshipTypeOptionsCache = { value: options, fetchedAt: Date.now() };
  return options;
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
  /** Pipeline stage label; required for create. */
  stageLabel: string;
  /** HubSpot deal pipeline id (optional; falls back to env / default). */
  pipelineId?: string;
  /** Company lifecycle stage label to set on the company (sales pipelines). */
  lifecycleStageLabel?: string;
  /** Relationship type label to set on the company (Partnership pipeline). */
  relationshipTypeLabel?: string;
  /** When true, create even if the company already has deals. */
  force?: boolean;
};

export type CreateCompanyDealResult = {
  dealId: string;
  dealName: string;
  companyId: string;
  companyName: string;
  stageLabel: string;
  pipelineLabel: string;
  lifecycleStageLabel: string | null;
  relationshipTypeLabel: string | null;
  associatedContactIds: string[];
};

/**
 * Create a deal on an existing company, named "[Company] - FlairX", and
 * associate the company plus every provided contact.
 * Optionally updates lifecycle stage (sales) or relationship type (Partnership).
 * Refuses if the company already has deals unless `force` is set.
 */
export async function createDealForCompany(
  input: CreateCompanyDealInput,
): Promise<CreateCompanyDealResult> {
  const pipeline = await getPipelineMeta(input.pipelineId);
  const stageLabel = input.stageLabel.trim();
  const stage = pipeline.stageByLabel.get(stageLabel.toLowerCase());

  if (!stage) {
    throw new Error(
      `Unknown deal pipeline stage "${input.stageLabel}" in pipeline "${pipeline.label}"`,
    );
  }

  let lifecycleValue: string | null = null;
  let lifecycleLabel: string | null = null;
  if (input.lifecycleStageLabel?.trim()) {
    const options = await getCompanyLifecycleStageOptions();
    const match = options.find(
      (o) =>
        o.label.toLowerCase() === input.lifecycleStageLabel!.trim().toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `Unknown company lifecycle stage "${input.lifecycleStageLabel}"`,
      );
    }
    lifecycleValue = match.value;
    lifecycleLabel = match.label;
  }

  let relationshipValue: string | null = null;
  let relationshipLabel: string | null = null;
  if (input.relationshipTypeLabel?.trim()) {
    const options = await getRelationshipTypeOptions();
    const match = options.find(
      (o) =>
        o.label.toLowerCase() ===
        input.relationshipTypeLabel!.trim().toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `Unknown relationship type "${input.relationshipTypeLabel}"`,
      );
    }
    relationshipValue = match.value;
    relationshipLabel = match.label;
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

  const companyUpdates: Record<string, string> = {};
  if (lifecycleValue) {
    companyUpdates.lifecyclestage = lifecycleValue;
  }
  if (relationshipValue) {
    companyUpdates[relationshipTypeProperty()] = relationshipValue;
  }
  if (Object.keys(companyUpdates).length > 0) {
    await updateObjectProperties("companies", input.companyId, companyUpdates);
  }

  return {
    dealId: deal.id,
    dealName,
    companyId: input.companyId,
    companyName: input.companyName,
    stageLabel: stage.label,
    pipelineLabel: pipeline.label,
    lifecycleStageLabel: lifecycleLabel,
    relationshipTypeLabel: relationshipLabel,
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

export type MarketingJunkContact = {
  id: string;
  name: string;
  email: string;
  companyId: string | null;
  companyName: string;
  sourceLabel: string;
  reason: string;
};

export type MarketingJunkCompany = {
  id: string;
  name: string;
  domain: string;
  reason: string;
};

export type MarketingJunkScan = {
  contacts: MarketingJunkContact[];
  companies: MarketingJunkCompany[];
  truncated: boolean;
};

const MARKETING_EMAIL_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "marketing",
  "updates",
  "notifications",
  "mailer-daemon",
];

function internalEmailDomains(): string[] {
  const raw =
    process.env.INTERNAL_EMAIL_DOMAINS?.trim() ||
    process.env.GMAIL_SENDER_EMAIL?.split("@")[1] ||
    "flairx.ai";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function isInternalEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return false;
  }
  return internalEmailDomains().some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}

function isMarketingLocalPart(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return MARKETING_EMAIL_LOCAL_PARTS.some(
    (p) =>
      local === p || local.startsWith(`${p}+`) || local.startsWith(`${p}.`),
  );
}

function looksLikeConversationsSource(
  source: string,
  sourceLabel: string,
  detail: string,
): boolean {
  const blob = `${source} ${sourceLabel} ${detail}`.toLowerCase();
  return (
    blob.includes("conversation") ||
    source.toUpperCase() === "CONVERSATIONS" ||
    source.toUpperCase() === "EMAIL_INTEGRATION"
  );
}

async function contactHasDeals(contactId: string): Promise<boolean> {
  const associations = await hubspotFetch<HubSpotAssociationResponse>(
    `/crm/v4/objects/contacts/${contactId}/associations/deals`,
  ).catch(() => ({ results: [] }) as HubSpotAssociationResponse);
  return associations.results.length > 0;
}

export type ScanMarketingJunkOptions = {
  /** Only include contacts created at/after this unix ms timestamp. */
  createdAfterMs?: number;
};

type HubSpotSearchFilter = {
  propertyName: string;
  operator: string;
  value: string;
};

function marketingSourceFilterGroups(
  createdAfterMs?: number,
): Array<{ filters: HubSpotSearchFilter[] }> {
  const createdFilter: HubSpotSearchFilter | null =
    createdAfterMs != null
      ? {
          propertyName: "createdate",
          operator: "GTE",
          value: String(createdAfterMs),
        }
      : null;

  const withCreated = (
    filters: HubSpotSearchFilter[],
  ): HubSpotSearchFilter[] =>
    createdFilter ? [...filters, createdFilter] : filters;

  return [
    {
      filters: withCreated([
        {
          propertyName: "hs_object_source",
          operator: "EQ",
          value: "CONVERSATIONS",
        },
      ]),
    },
    {
      filters: withCreated([
        {
          propertyName: "hs_object_source",
          operator: "EQ",
          value: "EMAIL_INTEGRATION",
        },
      ]),
    },
    {
      filters: withCreated([
        {
          propertyName: "hs_object_source_label",
          operator: "CONTAINS_TOKEN",
          value: "Conversations",
        },
      ]),
    },
  ];
}

const MARKETING_SCAN_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "company",
  "hs_lead_status",
  "hs_object_source",
  "hs_object_source_label",
  "hs_object_source_detail_1",
  "createdate",
];

async function searchContactsForMarketingScan(
  maxResults: number,
  createdAfterMs?: number,
): Promise<HubSpotSearchResult[]> {
  const filterGroups = marketingSourceFilterGroups(createdAfterMs);
  const results: HubSpotSearchResult[] = [];
  let after: string | undefined;

  while (results.length < maxResults) {
    const page = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/contacts/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups,
          properties: MARKETING_SCAN_PROPERTIES,
          limit: Math.min(100, maxResults - results.length),
          sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
          ...(after ? { after } : {}),
        }),
      },
    );
    results.push(...page.results);
    after = page.paging?.next?.after;
    if (!after || page.results.length === 0) {
      break;
    }
  }

  return results;
}

/**
 * Find auto-created inbound marketing / cold-outreach contacts (Conversations /
 * email integration, no deals) and companies that only have those contacts.
 */
export async function scanMarketingJunk(
  maxContacts = 40,
  options: ScanMarketingJunkOptions = {},
): Promise<MarketingJunkScan> {
  const scanCap = Math.max(maxContacts * 3, 60);
  const createdAfterMs = options.createdAfterMs;
  let raw: HubSpotSearchResult[] = [];
  try {
    raw = await searchContactsForMarketingScan(scanCap, createdAfterMs);
  } catch (error) {
    console.warn("[cleanup] primary contact search failed:", error);
    const page = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/contacts/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: marketingSourceFilterGroups(createdAfterMs).slice(0, 2),
          properties: MARKETING_SCAN_PROPERTIES,
          sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
          limit: scanCap,
        }),
      },
    );
    raw = page.results;
  }

  const contacts: MarketingJunkContact[] = [];
  const junkContactIds = new Set<string>();
  const companyIdsFromJunk = new Set<string>();

  for (const contact of raw) {
    if (contacts.length >= maxContacts) {
      break;
    }

    if (createdAfterMs != null) {
      const createdRaw = contact.properties.createdate?.trim() ?? "";
      const createdMs = Number(createdRaw);
      if (Number.isFinite(createdMs) && createdMs < createdAfterMs) {
        continue;
      }
    }

    const email = contact.properties.email?.trim() ?? "";
    if (email && isInternalEmail(email)) {
      continue;
    }

    const source = contact.properties.hs_object_source?.trim() ?? "";
    const sourceLabel =
      contact.properties.hs_object_source_label?.trim() ?? "";
    const detail =
      contact.properties.hs_object_source_detail_1?.trim() ?? "";

    const marketingLocal = email ? isMarketingLocalPart(email) : false;
    const conversations = looksLikeConversationsSource(
      source,
      sourceLabel,
      detail,
    );
    if (!conversations && !marketingLocal) {
      continue;
    }

    if (await contactHasDeals(contact.id)) {
      continue;
    }

    const first = contact.properties.firstname?.trim() ?? "";
    const last = contact.properties.lastname?.trim() ?? "";
    const name = `${first} ${last}`.trim() || email || "Unknown contact";

    let companyId: string | null = null;
    let companyName = contact.properties.company?.trim() ?? "";
    try {
      const company = await getAssociatedCompany(contact.id);
      if (company) {
        companyId = company.id;
        companyName = company.name || companyName;
        companyIdsFromJunk.add(company.id);
      }
    } catch {
      // ignore association failures
    }

    const reason = conversations
      ? `auto-created (${sourceLabel || source || "Conversations"}) · 0 deals`
      : `marketing-style email · 0 deals`;

    contacts.push({
      id: contact.id,
      name,
      email,
      companyId,
      companyName,
      sourceLabel: sourceLabel || source || "—",
      reason,
    });
    junkContactIds.add(contact.id);
  }

  const companies: MarketingJunkCompany[] = [];
  for (const companyId of companyIdsFromJunk) {
    if (companies.length >= maxContacts) {
      break;
    }
    try {
      const status = await getCompanyStatus(companyId);
      if (status.deals.length > 0) {
        continue;
      }
      const otherContacts = status.contacts.filter(
        (c) => !junkContactIds.has(c.id),
      );
      if (otherContacts.length > 0) {
        continue;
      }
      companies.push({
        id: companyId,
        name: status.name,
        domain: status.domain,
        reason: "0 deals · only marketing/auto-created contacts",
      });
    } catch {
      // skip company on lookup failure
    }
  }

  return {
    contacts,
    companies,
    truncated: raw.length >= scanCap || contacts.length >= maxContacts,
  };
}

/** Soft-delete (archive) a HubSpot contact or company. Restorable ~90 days. */
export async function archiveCrmObject(
  objectType: "contacts" | "companies",
  id: string,
): Promise<void> {
  await hubspotFetch(`/crm/v3/objects/${objectType}/${id}`, {
    method: "DELETE",
  });
}

export async function archiveMarketingJunk(input: {
  contactIds: string[];
  companyIds: string[];
}): Promise<{
  archivedContacts: number;
  archivedCompanies: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let archivedContacts = 0;
  let archivedCompanies = 0;

  for (const id of input.contactIds) {
    try {
      await archiveCrmObject("contacts", id);
      archivedContacts += 1;
    } catch (error) {
      errors.push(
        `contact ${id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }

  for (const id of input.companyIds) {
    try {
      await archiveCrmObject("companies", id);
      archivedCompanies += 1;
    } catch (error) {
      errors.push(
        `company ${id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }

  return { archivedContacts, archivedCompanies, errors };
}

export type UnnamedCompanyCleanupResult = {
  archivedCompanies: number;
  archivedContacts: number;
  neverLogEmails: string[];
  neverLogDomains: string[];
  errors: string[];
  items: Array<{
    companyId: string;
    domain: string;
    contactIds: string[];
    emails: string[];
  }>;
};

function isBlankCompanyName(name: string | null | undefined): boolean {
  return !name?.trim();
}

/**
 * Find companies with no name (optionally created after `createdAfterMs`),
 * archive them and their associated contacts (skip if any deals), and return
 * emails/domains for Never Log.
 */
export async function cleanupUnnamedCompanies(
  options: { createdAfterMs?: number; maxCompanies?: number } = {},
): Promise<UnnamedCompanyCleanupResult> {
  const maxCompanies = options.maxCompanies ?? 40;
  const createdAfterMs = options.createdAfterMs;
  const createdFilter =
    createdAfterMs != null
      ? {
          propertyName: "createdate",
          operator: "GTE",
          value: String(createdAfterMs),
        }
      : null;

  const filterGroups = [
    {
      filters: [
        { propertyName: "name", operator: "NOT_HAS_PROPERTY" },
        ...(createdFilter ? [createdFilter] : []),
      ],
    },
    {
      filters: [
        { propertyName: "name", operator: "EQ", value: "" },
        ...(createdFilter ? [createdFilter] : []),
      ],
    },
  ];

  let raw: HubSpotSearchResult[] = [];
  try {
    const page = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/companies/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups,
          properties: ["name", "domain", "createdate"],
          sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
          limit: Math.min(100, maxCompanies * 2),
        }),
      },
    );
    raw = page.results;
  } catch (error) {
    console.warn("[cleanup] unnamed company search failed:", error);
    // Fallback: recent companies, filter blank names client-side.
    const filters = createdFilter ? [createdFilter] : [];
    const page = await hubspotFetch<HubSpotSearchResponse>(
      "/crm/v3/objects/companies/search",
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: filters.length > 0 ? [{ filters }] : undefined,
          properties: ["name", "domain", "createdate"],
          sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
          limit: 100,
        }),
      },
    );
    raw = page.results.filter((c) =>
      isBlankCompanyName(c.properties.name),
    );
  }

  const result: UnnamedCompanyCleanupResult = {
    archivedCompanies: 0,
    archivedContacts: 0,
    neverLogEmails: [],
    neverLogDomains: [],
    errors: [],
    items: [],
  };

  for (const company of raw) {
    if (result.items.length >= maxCompanies) {
      break;
    }
    if (!isBlankCompanyName(company.properties.name)) {
      continue;
    }
    if (createdAfterMs != null) {
      const createdMs = Number(company.properties.createdate ?? "");
      if (Number.isFinite(createdMs) && createdMs < createdAfterMs) {
        continue;
      }
    }

    try {
      const status = await getCompanyStatus(company.id);
      if (status.deals.length > 0) {
        continue;
      }

      const emails = status.contacts
        .map((c) => c.email.trim().toLowerCase())
        .filter(Boolean);
      const domain = status.domain.trim().toLowerCase();
      const contactIds = status.contacts.map((c) => c.id);

      for (const contactId of contactIds) {
        try {
          await archiveCrmObject("contacts", contactId);
          result.archivedContacts += 1;
        } catch (error) {
          result.errors.push(
            `contact ${contactId}: ${error instanceof Error ? error.message : "failed"}`,
          );
        }
      }

      try {
        await archiveCrmObject("companies", company.id);
        result.archivedCompanies += 1;
      } catch (error) {
        result.errors.push(
          `company ${company.id}: ${error instanceof Error ? error.message : "failed"}`,
        );
        continue;
      }

      result.items.push({
        companyId: company.id,
        domain,
        contactIds,
        emails,
      });
      result.neverLogEmails.push(...emails);
      if (domain) {
        result.neverLogDomains.push(domain);
      }
    } catch (error) {
      result.errors.push(
        `company ${company.id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }

  result.neverLogEmails = [...new Set(result.neverLogEmails)];
  result.neverLogDomains = [...new Set(result.neverLogDomains)];
  return result;
}

