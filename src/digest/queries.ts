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
import { getRecentThreadForEmail } from "../integrations/gmail.js";
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

function formatActivityForModel(
  deal: OpenDeal,
  daysQuiet: number,
  pastClose: boolean,
  bundle: DealFollowUpBundle,
  gmailThread: string,
): string {
  const emails = bundle.emails
    .slice(0, 6)
    .map((email) => {
      const when = email.timestampMs
        ? new Date(email.timestampMs).toISOString().slice(0, 10)
        : "";
      const dir = emailDirectionLabel(email.direction) || "email";
      return `[${when}] ${dir} · ${email.subject || "(no subject)"}\nFrom: ${email.from}\nTo: ${email.to}\n${email.body.slice(0, 900)}`;
    })
    .join("\n\n---\n\n");

  const notes = [
    ...bundle.notes.map((n) => n.body),
    bundle.dealNotes,
    bundle.company?.notes ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2500);

  return [
    `Deal: ${deal.name}`,
    `Stage: ${deal.stageLabel}`,
    `Days since last HubSpot activity: ${daysQuiet}`,
    pastClose && deal.closeDate
      ? `Close date past: ${formatCloseDate(deal.closeDate)}`
      : "",
    `Contacts: ${bundle.contacts.map((c) => `${c.name} <${c.email}>`).join("; ") || "(none)"}`,
    `Company: ${bundle.company?.name ?? "(none)"}`,
    "",
    "HubSpot logged emails:",
    emails || "(none)",
    "",
    "Gmail thread:",
    gmailThread || "(none)",
    "",
    "Notes:",
    notes || "(none)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

type FollowUpVerdict = {
  needsFollowUp: boolean;
  why: string;
};

/**
 * Decide which deals need a follow-up by reading each deal's email/activity
 * context — not by quiet-day thresholds alone.
 */
async function classifyDealsFromActivity(
  rows: Array<{ id: string; activity: string }>,
): Promise<Map<string, FollowUpVerdict>> {
  const out = new Map<string, FollowUpVerdict>();
  if (!process.env.OPENAI_API_KEY || rows.length === 0) {
    return out;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1";
  const batchSize = 6;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      const completion = await openai.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are FlairX GTM ops. For each open deal, read the email chain and notes, then decide if a human follow-up is needed TODAY.

needsFollowUp=true when:
- We sent the last email and they haven't replied (ball in their court for too long), OR
- They replied / asked something and we haven't answered, OR
- A next step was promised (demo, intro, proposal, meeting) and it's overdue / unconfirmed, OR
- Close date passed with no recent progress, OR
- Stage is active but there is no meaningful email/note trail and outreach is needed.

needsFollowUp=false when:
- Conversation is active and recent (they or we just engaged), OR
- They asked to pause / revisit later and that date isn't due, OR
- Deal is intentionally waiting on an internal step with a clear recent note, OR
- There is nothing actionable yet.

why must be one specific sentence grounded in the emails/notes (max 160 chars). No fluff, no "it looks like".

Reply JSON: {"results":[{"id":"...","needsFollowUp":true,"why":"..."}]}`,
          },
          {
            role: "user",
            content: JSON.stringify(
              batch.map((row) => ({
                id: row.id,
                activity: row.activity.slice(0, 7000),
              })),
            ),
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as {
        results?: Array<{
          id?: string;
          needsFollowUp?: boolean;
          why?: string;
        }>;
      };
      for (const result of parsed.results ?? []) {
        if (!result.id) {
          continue;
        }
        out.set(result.id, {
          needsFollowUp: result.needsFollowUp === true,
          why: result.why?.trim() || "",
        });
      }
    } catch (error) {
      console.warn("[digest] activity follow-up classify failed:", error);
    }
  }

  return out;
}

function fallbackNeedsFollowUp(
  daysQuiet: number,
  pastClose: boolean,
  stageLabel: string,
  hasEmailTrail: boolean,
): boolean {
  if (pastClose) {
    return true;
  }
  // Conservative fallback if the model is unavailable: quiet + no recent trail.
  const threshold = LATE_STAGE_LABELS.has(stageLabel.trim().toLowerCase())
    ? envInt("STALL_DAYS_LATE_STAGE", 7)
    : envInt("STALL_DAYS_EARLY_STAGE", 14);
  return daysQuiet >= threshold && (!hasEmailTrail || daysQuiet >= threshold);
}

/**
 * Scan open deals only. Read each deal's HubSpot emails/notes (+ Gmail thread
 * when available) and keep deals where activity analysis says a follow-up is
 * needed. Skips paused stages (On Hold / Nurture / Inactive).
 */
export async function queryDealsNeedingFollowUp(
  deals: OpenDeal[],
): Promise<DealFollowUp[]> {
  const now = Date.now();
  const todayStart = startOfTodayMs();
  const maxScan = Math.max(envInt("DIGEST_MAX_SCAN", 40), envInt("DIGEST_MAX_ROWS", 8));

  const active = deals
    .filter(
      (deal) => !PAUSED_STAGE_LABELS.has(deal.stageLabel.trim().toLowerCase()),
    )
    .slice(0, maxScan);

  const enriched = await mapPool(active, 4, async (deal) => {
    const nativeMs = await latestNoteTimestampMs("deals", deal.id).catch(
      () => null,
    );
    const quietFrom =
      Math.max(deal.notesLastUpdated ?? 0, nativeMs ?? 0) ||
      deal.createdAt ||
      0;
    const daysQuiet = daysSince(quietFrom || null, now);
    const closeMs = deal.closeDate ? Date.parse(deal.closeDate) : NaN;
    const pastClose = Number.isFinite(closeMs) && closeMs < todayStart;

    const bundle = await getDealFollowUpBundle(deal.id).catch(
      (): DealFollowUpBundle => ({
        dealId: deal.id,
        dealNotes: "",
        company: null,
        contacts: [],
        notes: [],
        emails: [],
      }),
    );
    const contact =
      bundle.contacts.find((c) => c.email) ?? bundle.contacts[0];

    let gmailThread = "";
    if (contact?.email) {
      const thread = await getRecentThreadForEmail(contact.email).catch(
        () => null,
      );
      if (thread?.text) {
        gmailThread = `Subject: ${thread.subject}\n${thread.text}`.slice(
          0,
          5000,
        );
      }
    }

    const activity = formatActivityForModel(
      deal,
      daysQuiet,
      pastClose,
      bundle,
      gmailThread,
    );

    return {
      ...deal,
      daysQuiet,
      pastClose,
      contactId: contact?.id ?? "",
      contactName: contact?.name ?? "",
      contactEmail: contact?.email ?? "",
      canDraft: Boolean(contact?.email),
      hasEmailTrail:
        bundle.emails.length > 0 || gmailThread.length > 0 || Boolean(bundle.dealNotes),
      activity,
      why: heuristicWhy(deal, daysQuiet, pastClose, bundle),
    };
  });

  const verdicts = await classifyDealsFromActivity(
    enriched.map((row) => ({ id: row.id, activity: row.activity })),
  );

  const needed = enriched
    .filter((row) => {
      const verdict = verdicts.get(row.id);
      if (verdict) {
        return verdict.needsFollowUp;
      }
      return fallbackNeedsFollowUp(
        row.daysQuiet,
        row.pastClose,
        row.stageLabel,
        row.hasEmailTrail,
      );
    })
    .map((row) => {
      const verdict = verdicts.get(row.id);
      return {
        id: row.id,
        name: row.name,
        amount: row.amount,
        stageId: row.stageId,
        stageLabel: row.stageLabel,
        closeDate: row.closeDate,
        lastModified: row.lastModified,
        notesLastUpdated: row.notesLastUpdated,
        createdAt: row.createdAt,
        daysQuiet: row.daysQuiet,
        why: verdict?.why || row.why,
        contactId: row.contactId,
        contactName: row.contactName,
        contactEmail: row.contactEmail,
        canDraft: row.canDraft,
      };
    })
    .sort((a, b) => b.daysQuiet - a.daysQuiet);

  return needed;
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
