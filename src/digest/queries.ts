import OpenAI from "openai";
import {
  batchReadCompanies,
  getDealFollowUpBundle,
  getDealStageLabels,
  getLeadStatusMap,
  getPipelineMeta,
  latestNoteTimestampMs,
  searchObjects,
  type DealFollowUpBundle,
} from "../integrations/hubspot.js";
import {
  contactActivityDateProperty,
  dealActivityDateProperty,
  WRITABLE_LAST_ACTIVITY_FALLBACK,
} from "../lib/noteProperties.js";
import {
  daysAgoMs,
  daysSince,
  envInt,
  startOfTodayMs,
} from "./format.js";

/** Quiet if date is older than threshold, OR the date property is unset. */
function quietDateFilterGroups(
  baseFilters: Array<Record<string, unknown>>,
  dateProperty: string,
  olderThanMs: number,
): Array<{ filters: Array<Record<string, unknown>> }> {
  return [
    {
      filters: [
        ...baseFilters,
        {
          propertyName: dateProperty,
          operator: "LT",
          value: String(olderThanMs),
        },
      ],
    },
    {
      filters: [
        ...baseFilters,
        {
          propertyName: dateProperty,
          operator: "NOT_HAS_PROPERTY",
        },
      ],
    },
  ];
}

export type OpenDeal = {
  id: string;
  name: string;
  amount: number | null;
  stageId: string;
  stageLabel: string;
  closeDate: string | null;
  lastModified: number | null;
  notesLastUpdated: number | null;
  createdAt: number | null;
};

export type StalledDeal = OpenDeal & {
  daysQuiet: number;
};

export type DealFollowUp = OpenDeal & {
  daysQuiet: number;
  why: string;
  contactId: string;
  contactName: string;
  contactEmail: string;
  canDraft: boolean;
};

export type FollowUpContact = {
  id: string;
  name: string;
  email: string;
  companyName: string;
  leadStatusLabel: string;
  daysOverdue: number;
};

export type OverdueTask = {
  id: string;
  subject: string;
  dueAt: number | null;
};

export type PipelineSnapshot = {
  openCount: number;
  rawTotal: number;
  weightedTotal: number;
  byStage: Array<{ label: string; count: number; amount: number }>;
  pastCloseCount: number;
  deals: OpenDeal[];
};

function parseMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseAmount(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export async function queryOpenDeals(): Promise<PipelineSnapshot> {
  const [pipeline, stageLabels] = await Promise.all([
    getPipelineMeta(),
    getDealStageLabels(),
  ]);
  const results = await searchObjects("deals", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "hs_is_closed",
            operator: "EQ",
            value: "false",
          },
        ],
      },
    ],
    properties: [
      "dealname",
      "amount",
      "dealstage",
      "closedate",
      "hs_lastmodifieddate",
      dealActivityDateProperty(),
      WRITABLE_LAST_ACTIVITY_FALLBACK,
      "hubspot_owner_id",
    ],
    sorts: [{ propertyName: "amount", direction: "DESCENDING" }],
  });

  const todayStart = startOfTodayMs();
  const activityDateProp = dealActivityDateProperty();

  const deals: OpenDeal[] = results.map((deal) => {
    const stageId = deal.properties.dealstage ?? "";
    const activityMs = Math.max(
      parseMs(deal.properties[activityDateProp]) ?? 0,
      parseMs(deal.properties[WRITABLE_LAST_ACTIVITY_FALLBACK]) ?? 0,
    );
    return {
      id: deal.id,
      name: deal.properties.dealname?.trim() || "Untitled deal",
      amount: parseAmount(deal.properties.amount),
      stageId,
      stageLabel:
        stageLabels.get(stageId) ??
        pipeline.stageById.get(stageId)?.label ??
        stageId,
      closeDate: deal.properties.closedate ?? null,
      lastModified: parseMs(deal.properties.hs_lastmodifieddate),
      notesLastUpdated: activityMs > 0 ? activityMs : null,
      createdAt: deal.createdAt ? Date.parse(deal.createdAt) : null,
    };
  });

  const byStageMap = new Map<
    string,
    { label: string; count: number; amount: number }
  >();
  let rawTotal = 0;
  let weightedTotal = 0;
  let pastCloseCount = 0;

  for (const deal of deals) {
    const amount = deal.amount ?? 0;
    rawTotal += amount;
    const probability = pipeline.stageById.get(deal.stageId)?.probability ?? 0;
    weightedTotal += amount * probability;

    const existing = byStageMap.get(deal.stageId) ?? {
      label: deal.stageLabel,
      count: 0,
      amount: 0,
    };
    existing.count += 1;
    existing.amount += amount;
    byStageMap.set(deal.stageId, existing);

    if (deal.closeDate) {
      const closeMs = Date.parse(deal.closeDate);
      if (!Number.isNaN(closeMs) && closeMs < todayStart) {
        pastCloseCount += 1;
      }
    }
  }

  return {
    openCount: deals.length,
    rawTotal,
    weightedTotal,
    byStage: [...byStageMap.values()],
    pastCloseCount,
    deals,
  };
}

export async function queryStalledDeals(): Promise<StalledDeal[]> {
  const pipeline = await getPipelineMeta();
  const lateDays = envInt("STALL_DAYS_LATE_STAGE", 7);
  const earlyDays = envInt("STALL_DAYS_EARLY_STAGE", 14);
  const now = Date.now();

  const lateLabels = ["Demo Completed", "Proposal Sent", "Negotiation"];
  const earlyLabels = ["Prospecting", "Initial Contact", "Demo Scheduled"];

  const lateStageIds = lateLabels
    .map((label) => pipeline.stageByLabel.get(label.toLowerCase())?.id)
    .filter((id): id is string => Boolean(id));
  const earlyStageIds = earlyLabels
    .map((label) => pipeline.stageByLabel.get(label.toLowerCase())?.id)
    .filter((id): id is string => Boolean(id));

  const activityDateProp = dealActivityDateProperty();
  const filterGroups: Array<{ filters: Array<Record<string, unknown>> }> = [];

  if (lateStageIds.length > 0) {
    filterGroups.push(
      ...quietDateFilterGroups(
        [
          { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
          { propertyName: "dealstage", operator: "IN", values: lateStageIds },
        ],
        activityDateProp,
        daysAgoMs(lateDays, now),
      ),
    );
  }

  if (earlyStageIds.length > 0) {
    filterGroups.push(
      ...quietDateFilterGroups(
        [
          { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
          { propertyName: "dealstage", operator: "IN", values: earlyStageIds },
        ],
        activityDateProp,
        daysAgoMs(earlyDays, now),
      ),
    );
  }

  if (filterGroups.length === 0) {
    return [];
  }

  const results = await searchObjects("deals", {
    filterGroups,
    properties: [
      "dealname",
      "amount",
      "dealstage",
      activityDateProp,
      "hubspot_owner_id",
      "closedate",
      "hs_lastmodifieddate",
    ],
  });

  const stalled: StalledDeal[] = results.map((deal) => {
    const stageId = deal.properties.dealstage ?? "";
    const notesLastUpdated = parseMs(deal.properties[activityDateProp]);
    const createdAt = deal.createdAt ? Date.parse(deal.createdAt) : null;
    const lastModified = parseMs(deal.properties.hs_lastmodifieddate);
    const quietFrom = notesLastUpdated ?? createdAt ?? lastModified;

    return {
      id: deal.id,
      name: deal.properties.dealname?.trim() || "Untitled deal",
      amount: parseAmount(deal.properties.amount),
      stageId,
      stageLabel: pipeline.stageById.get(stageId)?.label ?? stageId,
      closeDate: deal.properties.closedate ?? null,
      lastModified,
      notesLastUpdated,
      createdAt,
      daysQuiet: daysSince(quietFrom, now),
    };
  });

  // Native HubSpot notes (e.g. written from Codex/HubSpot MCP) also count as
  // recent activity, so re-check each stalled candidate against its latest note
  // and drop any that are no longer quiet past their stage threshold.
  const lateStageSet = new Set(lateStageIds);
  const enriched = await Promise.all(
    stalled.map(async (deal) => {
      const nativeMs = await latestNoteTimestampMs("deals", deal.id).catch(
        () => null,
      );
      if (!nativeMs) {
        return deal;
      }
      const quietFrom = Math.max(
        deal.notesLastUpdated ?? 0,
        nativeMs,
        deal.createdAt ?? 0,
        deal.lastModified ?? 0,
      );
      return {
        ...deal,
        notesLastUpdated: Math.max(deal.notesLastUpdated ?? 0, nativeMs),
        daysQuiet: daysSince(quietFrom, now),
      };
    }),
  );

  return enriched
    .filter(
      (deal) =>
        deal.daysQuiet >= (lateStageSet.has(deal.stageId) ? lateDays : earlyDays),
    )
    .sort((a, b) => b.daysQuiet - a.daysQuiet);
}

const PAUSED_STAGE_LABELS = new Set([
  "on hold",
  "inactive relationship",
  "nurture",
]);

const LATE_STAGE_LABELS = new Set([
  "demo completed",
  "proposal sent",
  "negotiation",
  "active relationship",
  "meeting complete",
]);

function snippet(text: string, max = 90): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function lastNoteLine(notes: string): string {
  const lines = notes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function emailDirectionLabel(direction: string): string {
  const upper = direction.toUpperCase();
  if (upper.includes("OUT")) {
    return "outbound";
  }
  if (upper.includes("IN")) {
    return "inbound";
  }
  return "";
}

function formatCloseDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return "past due";
  }
  return new Date(parsed).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  });
}

function heuristicWhy(
  deal: OpenDeal,
  daysQuiet: number,
  pastClose: boolean,
  bundle: DealFollowUpBundle,
): string {
  const parts: string[] = [];
  if (pastClose && deal.closeDate) {
    parts.push(
      `Close date was ${formatCloseDate(deal.closeDate)}; still ${deal.stageLabel}`,
    );
  } else {
    parts.push(`${daysQuiet}d quiet in ${deal.stageLabel}`);
  }

  const lastEmail = bundle.emails[0];
  if (lastEmail) {
    const dir = emailDirectionLabel(lastEmail.direction);
    const subject = lastEmail.subject
      ? `"${snippet(lastEmail.subject, 48)}"`
      : "no subject";
    parts.push(`Last email${dir ? ` ${dir}` : ""}: ${subject}`);
  }

  const noteBody =
    bundle.notes.find((note) => note.body.trim())?.body ||
    lastNoteLine(bundle.dealNotes) ||
    lastNoteLine(bundle.company?.notes ?? "");
  if (noteBody) {
    parts.push(`Last note: ${snippet(noteBody, 80)}`);
  } else if (!lastEmail) {
    parts.push("No notes or logged emails");
  }

  return parts.join(". ");
}

async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

async function polishFollowUpReasons(
  rows: Array<{
    id: string;
    name: string;
    stageLabel: string;
    why: string;
    activity: string;
  }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!process.env.OPENAI_API_KEY || rows.length === 0) {
    return out;
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_CHEAP_MODEL ?? "gpt-4.1-mini";
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You write one-sentence GTM follow-up reasons. Be specific to the deal\'s notes/emails. No fluff, no "it looks like". Max 140 characters. Reply JSON: {"results":[{"id":"...","why":"..."}]}',
        },
        {
          role: "user",
          content: JSON.stringify(
            rows.map((row) => ({
              id: row.id,
              deal: row.name,
              stage: row.stageLabel,
              facts: row.why,
              activity: row.activity.slice(0, 1200),
            })),
          ),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      results?: Array<{ id?: string; why?: string }>;
    };
    for (const result of parsed.results ?? []) {
      if (result.id && result.why?.trim()) {
        out.set(result.id, result.why.trim());
      }
    }
  } catch (error) {
    console.warn("[digest] follow-up why polish failed:", error);
  }
  return out;
}

function stallThresholdDays(stageLabel: string): number {
  const lateDays = envInt("STALL_DAYS_LATE_STAGE", 7);
  const earlyDays = envInt("STALL_DAYS_EARLY_STAGE", 14);
  return LATE_STAGE_LABELS.has(stageLabel.trim().toLowerCase())
    ? lateDays
    : earlyDays;
}

/**
 * Open deals that need a follow-up: quiet past the stage threshold, or past
 * close date. Skips intentionally paused stages (On Hold / Nurture / Inactive).
 */
export async function queryDealsNeedingFollowUp(
  deals: OpenDeal[],
): Promise<DealFollowUp[]> {
  const now = Date.now();
  const todayStart = startOfTodayMs();
  const maxRows = Math.max(envInt("DIGEST_MAX_ROWS", 8) * 2, 12);

  const active = deals.filter(
    (deal) => !PAUSED_STAGE_LABELS.has(deal.stageLabel.trim().toLowerCase()),
  );

  const withQuiet = await mapPool(active, 5, async (deal) => {
    const nativeMs = await latestNoteTimestampMs("deals", deal.id).catch(
      () => null,
    );
    const quietFrom =
      Math.max(deal.notesLastUpdated ?? 0, nativeMs ?? 0) ||
      deal.createdAt ||
      0;
    const closeMs = deal.closeDate ? Date.parse(deal.closeDate) : NaN;
    const pastClose = Number.isFinite(closeMs) && closeMs < todayStart;
    return {
      deal,
      daysQuiet: daysSince(quietFrom || null, now),
      pastClose,
    };
  });

  const candidates = withQuiet
    .filter(
      (row) =>
        row.pastClose ||
        row.daysQuiet >= stallThresholdDays(row.deal.stageLabel),
    )
    .sort((a, b) => {
      if (a.pastClose !== b.pastClose) {
        return a.pastClose ? -1 : 1;
      }
      return b.daysQuiet - a.daysQuiet;
    })
    .slice(0, maxRows);

  const enriched = await mapPool(candidates, 4, async (row) => {
    const bundle = await getDealFollowUpBundle(row.deal.id).catch(
      (): DealFollowUpBundle => ({
        dealId: row.deal.id,
        dealNotes: "",
        company: null,
        contacts: [],
        notes: [],
        emails: [],
      }),
    );
    const contact =
      bundle.contacts.find((c) => c.email) ?? bundle.contacts[0];
    const activity = [
      ...bundle.notes.map((n) => n.body),
      ...bundle.emails.map(
        (e) => `${e.subject} ${e.body}`.trim(),
      ),
      bundle.dealNotes,
      bundle.company?.notes ?? "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      ...row.deal,
      daysQuiet: row.daysQuiet,
      why: heuristicWhy(row.deal, row.daysQuiet, row.pastClose, bundle),
      contactId: contact?.id ?? "",
      contactName: contact?.name ?? "",
      contactEmail: contact?.email ?? "",
      canDraft: Boolean(contact?.email),
      activity,
    };
  });

  const polished = await polishFollowUpReasons(
    enriched.map((row) => ({
      id: row.id,
      name: row.name,
      stageLabel: row.stageLabel,
      why: row.why,
      activity: row.activity,
    })),
  );

  return enriched.map((row) => {
    const { activity: _activity, ...rest } = row;
    return {
      ...rest,
      why: polished.get(row.id) || row.why,
    };
  });
}

export async function queryFollowUpContacts(): Promise<FollowUpContact[]> {
  const leadStatusMap = await getLeadStatusMap();
  const now = Date.now();
  const attemptedDays = envInt("FOLLOWUP_DAYS_ATTEMPTED", 4);
  const connectedDays = envInt("FOLLOWUP_DAYS_CONNECTED", 7);

  const attemptedValue =
    leadStatusMap.get("attempted to contact") ??
    leadStatusMap.get("attempted");
  const connectedValue = leadStatusMap.get("connected");

  const buckets: Array<{ value: string; label: string; days: number }> = [];
  if (attemptedValue) {
    buckets.push({
      value: attemptedValue,
      label: "Attempted to Contact",
      days: attemptedDays,
    });
  }
  if (connectedValue) {
    buckets.push({
      value: connectedValue,
      label: "Connected",
      days: connectedDays,
    });
  }

  const companyIds: string[] = [];
  const rows: Array<{
    id: string;
    name: string;
    email: string;
    companyId: string;
    leadStatusLabel: string;
    daysOverdue: number;
    lastActivityMs: number | null;
  }> = [];

  const activityDateProp = contactActivityDateProperty();

  for (const bucket of buckets) {
    const results = await searchObjects("contacts", {
      filterGroups: quietDateFilterGroups(
        [
          {
            propertyName: "hs_lead_status",
            operator: "EQ",
            value: bucket.value,
          },
        ],
        activityDateProp,
        daysAgoMs(bucket.days, now),
      ),
      properties: [
        "firstname",
        "lastname",
        "email",
        "hs_lead_status",
        activityDateProp,
        "associatedcompanyid",
      ],
    });

    for (const contact of results) {
      const first = contact.properties.firstname?.trim() ?? "";
      const last = contact.properties.lastname?.trim() ?? "";
      const companyId = contact.properties.associatedcompanyid ?? "";
      if (companyId) {
        companyIds.push(companyId);
      }

      const lastContact = parseMs(contact.properties[activityDateProp]);
      const createdAt = contact.createdAt
        ? Date.parse(contact.createdAt)
        : null;

      rows.push({
        id: contact.id,
        name: `${first} ${last}`.trim() || "Unknown contact",
        email: contact.properties.email?.trim() ?? "",
        companyId,
        leadStatusLabel: bucket.label,
        daysOverdue: daysSince(lastContact ?? createdAt, now),
        lastActivityMs: lastContact ?? createdAt,
      });
    }
  }

  const companyNames = await batchReadCompanies(companyIds);
  const bucketDays = new Map(buckets.map((b) => [b.label, b.days]));

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const base = {
        id: row.id,
        name: row.name,
        email: row.email,
        companyName: row.companyId ? companyNames.get(row.companyId) ?? "" : "",
        leadStatusLabel: row.leadStatusLabel,
        daysOverdue: row.daysOverdue,
      };

      const nativeMs = await latestNoteTimestampMs("contacts", row.id).catch(
        () => null,
      );
      if (!nativeMs) {
        return base;
      }
      const effective = Math.max(row.lastActivityMs ?? 0, nativeMs);
      return { ...base, daysOverdue: daysSince(effective, now) };
    }),
  );

  return enriched
    .filter(
      (row) =>
        row.daysOverdue >= (bucketDays.get(row.leadStatusLabel) ?? 0),
    )
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export async function queryOverdueTasks(): Promise<OverdueTask[]> {
  const now = Date.now();
  const results = await searchObjects("tasks", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "hs_task_status",
            operator: "NEQ",
            value: "COMPLETED",
          },
          {
            propertyName: "hs_timestamp",
            operator: "LT",
            value: String(now),
          },
        ],
      },
    ],
    properties: ["hs_task_subject", "hs_timestamp", "hubspot_owner_id"],
  });

  return results.map((task) => ({
    id: task.id,
    subject: task.properties.hs_task_subject?.trim() || "Untitled task",
    dueAt: parseMs(task.properties.hs_timestamp),
  }));
}
