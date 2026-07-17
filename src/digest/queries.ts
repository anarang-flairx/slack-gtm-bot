import {
  batchReadCompanies,
  getLeadStatusMap,
  getPipelineMeta,
  searchObjects,
} from "../integrations/hubspot.js";
import {
  contactActivityDateProperty,
  dealActivityDateProperty,
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
  const pipeline = await getPipelineMeta();
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
      "hubspot_owner_id",
    ],
    sorts: [{ propertyName: "amount", direction: "DESCENDING" }],
  });

  const todayStart = startOfTodayMs();
  const activityDateProp = dealActivityDateProperty();

  const deals: OpenDeal[] = results.map((deal) => {
    const stageId = deal.properties.dealstage ?? "";
    return {
      id: deal.id,
      name: deal.properties.dealname?.trim() || "Untitled deal",
      amount: parseAmount(deal.properties.amount),
      stageId,
      stageLabel: pipeline.stageById.get(stageId)?.label ?? stageId,
      closeDate: deal.properties.closedate ?? null,
      lastModified: parseMs(deal.properties.hs_lastmodifieddate),
      notesLastUpdated: parseMs(deal.properties[activityDateProp]),
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

  return results
    .map((deal) => {
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
    })
    .sort((a, b) => b.daysQuiet - a.daysQuiet);
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
      });
    }
  }

  const companyNames = await batchReadCompanies(companyIds);

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      companyName: row.companyId
        ? companyNames.get(row.companyId) ?? ""
        : "",
      leadStatusLabel: row.leadStatusLabel,
      daysOverdue: row.daysOverdue,
    }))
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
