import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import {
  findCompaniesByName,
  formatCompanyDealName,
  getCompanyStatus,
  getObjectProperties,
  getPipelineMeta,
  listDealCreatePipelines,
  preferFlairXSalesPipelineId,
} from "../integrations/hubspot.js";
import { hubspotRecordUrl } from "../digest/format.js";
import { savePendingCompanyDeal } from "./companyDealStore.js";
import {
  clearDealCreateSession,
  saveDealCreateSession,
  sessionKey,
} from "./dealCreateStore.js";
import { buildCompanyDealPreviewBlocks } from "./previews.js";
import type {
  DealCreateContact,
  DealCreatePipelineOption,
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
      pipelineLabel: label,
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

async function postApprovalCard(
  ctx: DealCreateContext,
  session: DealCreateSession,
  stageLabel: string,
): Promise<string> {
  const pipelineId = session.pipelineId;
  const pipelineLabel = session.pipelineLabel;
  if (!pipelineId || !pipelineLabel) {
    return "Pick a pipeline first.";
  }

  const dealName = formatCompanyDealName(session.companyName);
  const pending = savePendingCompanyDeal({
    companyId: session.companyId,
    companyName: session.companyName,
    dealName,
    pipelineId,
    pipelineLabel,
    stageLabel,
    companyFieldKind: "none",
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
      "none",
      session.contacts,
      pending.id,
      undefined,
    ),
  );

  clearDealCreateSession(ctx.channel, ctx.threadTs);
  return "[card ready] User reply only: Review the card above — Approve or Discard.";
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
    lower === "partnership"
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
    saveDealCreateSession({
      ...session,
      step: "stage",
      pipelineId: picked.id,
      pipelineLabel: label,
      stages,
    });
    return formatPick("What deal stage?", stages.map((s) => s.label));
  }

  const picked = resolvePick(userMessage, session.stages, (s) => s.label);
  if (!picked) {
    return formatPick(
      "What deal stage?",
      session.stages.map((s) => s.label),
    );
  }
  return postApprovalCard(ctx, session, picked.label);
}
