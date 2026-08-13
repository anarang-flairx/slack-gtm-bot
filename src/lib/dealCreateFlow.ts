import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import {
  findCompaniesByName,
  formatCompanyDealName,
  getCompanyStatus,
  getObjectProperties,
  getPipelineMeta,
  getRelationshipTypeOptions,
  isPartnershipPipeline,
  listDealCreatePipelines,
  preferFlairXSalesPipelineId,
} from "../integrations/hubspot.js";
import { hubspotRecordUrl } from "../digest/format.js";
import { savePendingCompanyDeal } from "./companyDealStore.js";
import {
  clearDealCreateSession,
  getDealCreateSession,
  saveDealCreateSession,
  sessionKey,
} from "./dealCreateStore.js";
import { buildCompanyDealPreviewBlocks } from "./previews.js";
import type {
  DealCreateContact,
  DealCreatePipelineOption,
  DealCreateRelationshipOption,
  DealCreateSession,
  DealCreateStageOption,
} from "../types/dealCreateSession.js";

export type DealCreateContext = {
  client: App["client"];
  channel: string;
  threadTs?: string;
  userId: string;
};

const CANCEL_REPLIES = new Set([
  "cancel",
  "never mind",
  "nevermind",
  "stop",
  "discard",
]);

function wrapPick(userText: string): string {
  return `[pick posted]\n<<<PICK_USER>>>\n${userText}\n<<<END_PICK_USER>>>`;
}

function formatPick(title: string, labels: string[]): string {
  const lines = labels.map((label, i) => `${i + 1}. ${label}`).join("\n");
  return wrapPick(`${title}\n${lines}\n\nReply with a number.`);
}

function resolvePick<T>(
  raw: string,
  items: T[],
  labelOf: (item: T) => string,
): T | undefined {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) {
    return items[n - 1];
  }
  const lower = trimmed.toLowerCase();
  return items.find((item) => labelOf(item).trim().toLowerCase() === lower);
}

async function loadPipelines(): Promise<DealCreatePipelineOption[]> {
  const listed = await listDealCreatePipelines();
  const partnerId = process.env.HUBSPOT_PARTNERSHIP_PIPELINE_ID?.trim() || "";
  const out: DealCreatePipelineOption[] = [];
  const seen = new Set<string>();

  for (const pipeline of listed) {
    let id = pipeline.id;
    if (!partnerId || id !== partnerId) {
      id = await preferFlairXSalesPipelineId(id);
    }
    if (seen.has(id)) {
      continue;
    }
    const meta = await getPipelineMeta(id);
    out.push({ id: meta.id, label: meta.label });
    seen.add(meta.id);
  }

  return out;
}

const DEFAULT_RELATIONSHIP_OPTIONS: DealCreateRelationshipOption[] = [
  { label: "Partner", value: "Partner" },
  { label: "Referral", value: "Referral" },
  { label: "Investor", value: "Investor" },
  { label: "Advisor", value: "Advisor" },
];

async function loadRelationshipOptions(): Promise<DealCreateRelationshipOption[]> {
  try {
    const options = await getRelationshipTypeOptions();
    if (options.length > 0) {
      return options;
    }
  } catch (error) {
    console.warn("[deal-create] relationship_type options failed:", error);
  }
  return DEFAULT_RELATIONSHIP_OPTIONS;
}

function needsRelationshipType(
  pipelineId: string,
  pipelineLabel: string,
  stages: Array<{ label: string }> = [],
): boolean {
  return isPartnershipPipeline(pipelineId, pipelineLabel, stages);
}

function resolvePipelineFields(session: DealCreateSession): {
  pipelineId: string;
  pipelineLabel: string;
} {
  let pipelineId = session.pipelineId?.trim() || "";
  let pipelineLabel = session.pipelineLabel?.trim() || "";

  if (pipelineId) {
    const match = session.pipelines.find((p) => p.id === pipelineId);
    if (match) {
      pipelineLabel = pipelineLabel || match.label;
    }
  }

  if (!pipelineId && pipelineLabel) {
    const match = session.pipelines.find(
      (p) => p.label.trim().toLowerCase() === pipelineLabel.toLowerCase(),
    );
    if (match) {
      pipelineId = match.id;
      pipelineLabel = match.label;
    }
  }

  if (!pipelineId || !pipelineLabel) {
    const fromStages = isPartnershipPipeline(
      pipelineId,
      pipelineLabel,
      session.stages,
    )
      ? session.pipelines.find((p) => isPartnershipPipeline(p.id, p.label))
      : undefined;
    if (fromStages) {
      pipelineId = pipelineId || fromStages.id;
      pipelineLabel = pipelineLabel || fromStages.label;
    }
  }

  return { pipelineId, pipelineLabel };
}

async function loadStages(
  pipelineId: string,
): Promise<{ label: string; stages: DealCreateStageOption[] }> {
  const meta = await getPipelineMeta(pipelineId);
  return {
    label: meta.label,
    stages: meta.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
    })),
  };
}

async function contactsForCompany(
  companyId: string,
): Promise<{
  contacts: DealCreateContact[];
  existingDealCount: number;
  dealLines: string;
}> {
  const status = await getCompanyStatus(companyId);
  const dealLines = status.deals
    .map((deal) => {
      const url = hubspotRecordUrl("deal", deal.id);
      return `• <${url}|${deal.name}> — ${deal.stage}`;
    })
    .join("\n");
  return {
    contacts: status.contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
    })),
    existingDealCount: status.deals.length,
    dealLines,
  };
}

function duplicateDealMessage(
  companyName: string,
  count: number,
  dealLines: string,
): string {
  return `${companyName} already has ${count} deal(s):\n${dealLines}\nSay *create another deal* if you want a second one.`;
}

async function postCard(
  ctx: DealCreateContext,
  text: string,
  blocks: KnownBlock[],
): Promise<void> {
  await ctx.client.chat.postMessage({
    channel: ctx.channel,
    ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
    text,
    blocks,
  });
}

async function askPipeline(
  session: Omit<DealCreateSession, "createdAt">,
): Promise<string> {
  if (session.pipelines.length === 1) {
    const only = session.pipelines[0];
    const { label, stages } = await loadStages(only.id);
    const next = saveDealCreateSession({
      ...session,
      step: "stage",
      pipelineId: only.id,
      pipelineLabel: label || only.label,
      stages,
    });
    return formatPick("What deal stage?", next.stages.map((s) => s.label));
  }

  saveDealCreateSession({
    ...session,
    step: "pipeline",
    stages: [],
  });
  return formatPick(
    "What pipeline?",
    session.pipelines.map((p) => p.label),
  );
}

async function askRelationshipType(
  session: DealCreateSession,
  stageLabel: string,
): Promise<string> {
  const relationshipOptions = await loadRelationshipOptions();
  saveDealCreateSession({
    ...session,
    step: "relationship",
    stageLabel,
    relationshipOptions,
  });
  return formatPick(
    "What relationship type?",
    relationshipOptions.map((o) => o.label),
  );
}

async function postApprovalCard(
  ctx: DealCreateContext,
  session: DealCreateSession,
  stageLabel: string,
  relationshipLabel?: string,
): Promise<string> {
  const { pipelineId, pipelineLabel } = resolvePipelineFields(session);
  if (!pipelineId || !pipelineLabel) {
    return "Pick a pipeline first.";
  }

  const withPipeline = {
    ...session,
    pipelineId,
    pipelineLabel,
  };

  if (
    !relationshipLabel &&
    needsRelationshipType(pipelineId, pipelineLabel, session.stages)
  ) {
    console.log("[deal-create] after stage", {
      pipelineId,
      pipelineLabel,
      needsRelationship: true,
    });
    return askRelationshipType(withPipeline, stageLabel);
  }

  const partnership = Boolean(relationshipLabel);
  const dealName = formatCompanyDealName(session.companyName);
  const pending = savePendingCompanyDeal({
    companyId: session.companyId,
    companyName: session.companyName,
    dealName,
    pipelineId,
    pipelineLabel,
    stageLabel,
    companyFieldKind: partnership ? "relationship" : "none",
    ...(relationshipLabel ? { companyFieldLabel: relationshipLabel } : {}),
    contacts: session.contacts,
    force: session.force,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
  });

  await postCard(
    ctx,
    `Company deal ready for ${session.companyName}`,
    buildCompanyDealPreviewBlocks(
      session.companyName,
      session.companyId,
      dealName,
      pipelineLabel,
      stageLabel,
      partnership ? "relationship" : "none",
      session.contacts,
      pending.id,
      undefined,
      relationshipLabel,
    ),
  );

  clearDealCreateSession(ctx.channel, ctx.threadTs);
  return "[card ready] User reply only: Review the card above — Approve or Discard.";
}

async function afterStagePicked(
  ctx: DealCreateContext,
  session: DealCreateSession,
  stageLabel: string,
): Promise<string> {
  const latest = getDealCreateSession(ctx.channel, ctx.threadTs);
  const merged: DealCreateSession = {
    ...session,
    ...(latest ?? {}),
    pipelineId: latest?.pipelineId || session.pipelineId,
    pipelineLabel: latest?.pipelineLabel || session.pipelineLabel,
    stages:
      (latest?.stages.length ?? 0) > 0 ? latest!.stages : session.stages,
    pipelines:
      (latest?.pipelines.length ?? 0) > 0
        ? latest!.pipelines
        : session.pipelines,
  };
  const { pipelineId, pipelineLabel } = resolvePipelineFields(merged);
  const nextSession: DealCreateSession = {
    ...merged,
    pipelineId,
    pipelineLabel,
  };
  const needs = needsRelationshipType(
    pipelineId,
    pipelineLabel,
    nextSession.stages,
  );
  console.log("[deal-create] after stage", {
    pipelineId,
    pipelineLabel,
    needsRelationship: needs,
  });

  if (needs) {
    return askRelationshipType(nextSession, stageLabel);
  }
  return postApprovalCard(ctx, nextSession, stageLabel);
}

export function isDealCreateCancel(text: string): boolean {
  return CANCEL_REPLIES.has(text.trim().toLowerCase().replace(/[?!.]+$/, ""));
}

export function isDealCreatePick(text: string): boolean {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return (
    lower === "sales" ||
    lower === "partnerships" ||
    lower === "partnership" ||
    lower === "partner" ||
    lower === "referral" ||
    lower === "investor" ||
    lower === "advisor"
  );
}

/**
 * Start pipeline → stage → approval card. Ignores model-supplied stage/pipeline
 * so Slack never shows invented lists or HubSpot ids.
 */
export async function startDealCreate(
  ctx: DealCreateContext,
  input: {
    companyName: string;
    companyId?: string;
    force?: boolean;
  },
): Promise<string> {
  const companyName = input.companyName.trim();
  if (!companyName) {
    return "Missing company name.";
  }

  const pipelines = await loadPipelines();
  if (pipelines.length === 0) {
    return "No HubSpot deal pipelines found.";
  }

  const base = {
    key: sessionKey(ctx.channel, ctx.threadTs),
    contacts: [] as DealCreateContact[],
    force: input.force === true,
    existingDealCount: 0,
    pipelines,
    stages: [] as DealCreateStageOption[],
    relationshipOptions: [] as DealCreateRelationshipOption[],
    createdBy: ctx.userId,
    channelId: ctx.channel,
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
  };

  if (input.companyId) {
    const props = await getObjectProperties("companies", input.companyId, [
      "name",
      "domain",
    ]);
    const { contacts, existingDealCount, dealLines } = await contactsForCompany(
      input.companyId,
    );
    if (existingDealCount > 0 && !base.force) {
      clearDealCreateSession(ctx.channel, ctx.threadTs);
      return duplicateDealMessage(
        props.name?.trim() || companyName,
        existingDealCount,
        dealLines,
      );
    }
    return askPipeline({
      ...base,
      companyId: input.companyId,
      companyName: props.name?.trim() || companyName,
      contacts,
      existingDealCount,
      step: "pipeline",
    });
  }

  const matches = await findCompaniesByName(companyName);
  if (matches.length === 0) {
    return `No company "${companyName}" in HubSpot.`;
  }
  if (matches.length > 1) {
    saveDealCreateSession({
      ...base,
      companyId: "",
      companyName,
      step: "company",
      companyOptions: matches.map((m) => ({
        id: m.id,
        name: m.name,
        domain: m.domain,
      })),
    });
    return formatPick(
      "Which company?",
      matches.map((m) => `${m.name}${m.domain ? ` — ${m.domain}` : ""}`),
    );
  }

  const company = matches[0];
  const { contacts, existingDealCount, dealLines } = await contactsForCompany(
    company.id,
  );
  if (existingDealCount > 0 && !base.force) {
    clearDealCreateSession(ctx.channel, ctx.threadTs);
    return duplicateDealMessage(company.name, existingDealCount, dealLines);
  }

  return askPipeline({
    ...base,
    companyId: company.id,
    companyName: company.name,
    contacts,
    existingDealCount,
    step: "pipeline",
  });
}

export async function continueDealCreate(
  ctx: DealCreateContext,
  session: DealCreateSession,
  userMessage: string,
): Promise<string> {
  if (isDealCreateCancel(userMessage)) {
    clearDealCreateSession(ctx.channel, ctx.threadTs);
    return "Deal creation cancelled.";
  }

  if (session.step === "company") {
    const options = session.companyOptions ?? [];
    const picked = resolvePick(userMessage, options, (c) => c.name);
    if (!picked) {
      return formatPick(
        "Which company?",
        options.map((c) => `${c.name}${c.domain ? ` — ${c.domain}` : ""}`),
      );
    }
    const { contacts, existingDealCount, dealLines } = await contactsForCompany(
      picked.id,
    );
    if (existingDealCount > 0 && !session.force) {
      clearDealCreateSession(ctx.channel, ctx.threadTs);
      return duplicateDealMessage(picked.name, existingDealCount, dealLines);
    }
    return askPipeline({
      ...session,
      companyId: picked.id,
      companyName: picked.name,
      contacts,
      existingDealCount,
      companyOptions: undefined,
      step: "pipeline",
    });
  }

  if (session.step === "pipeline") {
    const picked = resolvePick(
      userMessage,
      session.pipelines,
      (p) => p.label,
    );
    if (!picked) {
      return formatPick(
        "What pipeline?",
        session.pipelines.map((p) => p.label),
      );
    }
    const { label, stages } = await loadStages(picked.id);
    const saved = saveDealCreateSession({
      ...session,
      step: "stage",
      pipelineId: picked.id,
      pipelineLabel: label || picked.label,
      stages,
      relationshipOptions: [],
    });
    return formatPick("What deal stage?", saved.stages.map((s) => s.label));
  }

  if (session.step === "stage") {
    const picked = resolvePick(userMessage, session.stages, (s) => s.label);
    if (!picked) {
      return formatPick(
        "What deal stage?",
        session.stages.map((s) => s.label),
      );
    }
    const latest = getDealCreateSession(ctx.channel, ctx.threadTs) ?? session;
    return afterStagePicked(ctx, latest, picked.label);
  }

  const picked = resolvePick(
    userMessage,
    session.relationshipOptions,
    (o) => o.label,
  );
  if (!picked) {
    return formatPick(
      "What relationship type?",
      session.relationshipOptions.map((o) => o.label),
    );
  }
  return postApprovalCard(
    ctx,
    session,
    session.stageLabel ?? session.stages[0]?.label ?? "",
    picked.label,
  );
}
