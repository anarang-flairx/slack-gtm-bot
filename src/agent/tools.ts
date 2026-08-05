import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type OpenAI from "openai";
import {
  createProspect,
  findCompaniesByName,
  findContactsByName,
  getAssociatedCompany,
  getCompanyStatus,
  getLeadStatusMap,
  getObjectProperties,
  getPipelineMeta,
  findNoteRecords,
  resolveDealsForStageMove,
  type NoteRecordMatch,
} from "../integrations/hubspot.js";
import {
  getThreadContent,
  listThreadsAwaitingReply,
} from "../integrations/gmail.js";
import { buildDailyDigest } from "../digest/buildDailyDigest.js";
import { createDraftByContactId } from "../lib/createDraft.js";
import { saveDraft } from "../lib/draftStore.js";
import { savePendingLeadStatus } from "../lib/leadStatusStore.js";
import { savePendingNoteUpdate } from "../lib/noteUpdateStore.js";
import { savePendingProspect } from "../lib/prospectStore.js";
import { savePendingReminder } from "../lib/reminderStore.js";
import { savePendingStageMove } from "../lib/stageMoveStore.js";
import {
  buildCompanyStatusBlocks,
  buildCustomEmailDraftPreviewBlocks,
  buildEmailDraftPreviewBlocks,
  buildLeadStatusPreviewBlocks,
  buildNoteUpdatePreviewBlocks,
  buildProspectPreviewBlocks,
  buildReminderPreviewBlocks,
  buildStageMovePreviewBlocks,
} from "../lib/previews.js";
import type { ProspectFields } from "../lib/parseProspect.js";
import type { DraftType } from "../types/draft.js";

export type ToolContext = {
  client: App["client"];
  channel: string;
  threadTs?: string;
  userId: string;
};

async function postCard(
  ctx: ToolContext,
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

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_pipeline_stages",
      description:
        "List the HubSpot deal pipeline stages in order, with win probability. Use to answer questions about the sales pipeline stages.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lead_statuses",
      description:
        "List the HubSpot contact lead status options (e.g. New, Attempted, Connected). Use to answer questions about lead stages.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_lead_status",
      description:
        "Change a contact's HubSpot lead status (e.g. to Connected). Lead status is a CONTACT property. Posts an approval card; the status only changes after approval. If multiple contacts match the name, the tool returns a numbered list — show it to the user, ask them to reply with the number, then call this tool again with the chosen contact_id.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Contact name" },
          status: {
            type: "string",
            description: "Target lead status label, e.g. 'Connected'",
          },
          contact_id: {
            type: "string",
            description:
              "HubSpot contact id to disambiguate when the name matched multiple contacts (from a prior numbered list). Optional.",
          },
        },
        required: ["name", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_records",
      description:
        "Search HubSpot for contacts, deals, and companies matching a name. Use to look up records or disambiguate before another action.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name to search for" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_company_status",
      description:
        "Post a status card for a company: its deals, contacts, notes (including native HubSpot notes), and last activity. Use for 'what's the status of X'.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string" },
        },
        required: ["company_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "post_digest",
      description:
        "Build and post the GTM daily digest (pipeline snapshot, stalled deals, follow-ups due, overdue tasks) to the configured digest channel.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_notes",
      description:
        "Prepare a note to append to a contact, company, or deal. Posts an approval card; the note and last-activity date are only written after the user approves. Use for 'add a note to X'.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Contact, company, or deal name to attach the note to",
          },
          note: { type: "string", description: "The note text to append" },
        },
        required: ["name", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_prospect",
      description:
        "Prepare a new HubSpot contact (+ optional company) and a deal in the Prospecting stage. Posts an approval card; records are only created after approval. Use for 'add <person> to HubSpot'.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          company_name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          mobile: { type: "string" },
          title: { type: "string" },
          source: { type: "string", description: "Lead source for the deal" },
          notes: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["first_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_deal_stage",
      description:
        "Prepare a move of a deal to a different pipeline stage. Identify the deal by company name and/or deal name. Posts an approval card; the stage only changes after approval.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string" },
          deal_name: { type: "string" },
          target_stage: {
            type: "string",
            description: "Exact pipeline stage label to move the deal to",
          },
        },
        required: ["target_stage"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description:
        "Prepare a templated email draft (intro or event follow-up) for a contact, filled with HubSpot context. Posts an approval card; the Gmail draft is only saved after approval. The bot never sends email.",
      parameters: {
        type: "object",
        properties: {
          contact_name: { type: "string" },
          template: {
            type: "string",
            enum: ["intro", "event-follow-up"],
          },
        },
        required: ["contact_name", "template"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_custom_email",
      description:
        "Prepare a custom, context-aware email draft with a subject and body you write (e.g. a follow-up referencing a specific email thread). Posts an approval card; the Gmail draft is only saved after approval. The bot never sends email.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string" },
          body: {
            type: "string",
            description: "Full email body in markdown",
          },
          contact_name: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_follow_up",
      description:
        "Set a follow-up reminder for a contact, company, or deal in N days. Posts an approval card; on approve it creates a HubSpot task due then AND schedules a Slack nudge. Use for 'remind me to follow up with X in N days'.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Contact, company, or deal name",
          },
          days: {
            type: "number",
            description: "Days from now until the reminder (e.g. 2)",
          },
          note: {
            type: "string",
            description: "Optional context for the reminder",
          },
        },
        required: ["name", "days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_unanswered_emails",
      description:
        "List sent Gmail threads where the CEO sent the last message and no reply has arrived within `days`. Use to find people who need a follow-up.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Minimum days without a reply (default 7)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_email_thread",
      description:
        "Fetch the text content of a Gmail thread by id so you can summarize it or draft a context-aware reply.",
      parameters: {
        type: "object",
        properties: {
          thread_id: { type: "string" },
        },
        required: ["thread_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_email_to_notes",
      description:
        "Attach an email summary you wrote to a contact and its associated company as notes. Posts approval cards; notes are only written after approval. First read the thread with get_email_thread, then write the summary.",
      parameters: {
        type: "object",
        properties: {
          contact_name: { type: "string" },
          summary: {
            type: "string",
            description: "The summary text to append as a note",
          },
        },
        required: ["contact_name", "summary"],
      },
    },
  },
];

function formatMatch(match: NoteRecordMatch, index: number): string {
  return `${index + 1}. [${match.type}] ${match.name} — ${match.detail}`;
}

async function runUpdateNotes(
  ctx: ToolContext,
  name: string,
  note: string,
): Promise<string> {
  const result = await findNoteRecords(name);
  if (Array.isArray(result)) {
    const options = result.map(formatMatch).join("\n");
    return `Multiple records matched "${name}". Ask the user which one:\n${options}`;
  }

  const pending = savePendingNoteUpdate({
    recordType: result.type,
    recordId: result.id,
    recordName: result.name,
    recordDetail: result.detail,
    note,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });

  await postCard(
    ctx,
    `Notes update ready for ${result.name}`,
    buildNoteUpdatePreviewBlocks(result, note, pending.id),
  );

  return `Posted an approval card to append a note to ${result.type} "${result.name}". Waiting for the user to Approve or Discard.`;
}

async function runUpdateLeadStatus(
  ctx: ToolContext,
  name: string,
  status: string,
  contactId: string,
): Promise<string> {
  const statusLabel = status.trim();
  if (!statusLabel) {
    return "Missing target lead status.";
  }

  const statusMap = await getLeadStatusMap();
  const statusValue = statusMap.get(statusLabel.toLowerCase());
  if (!statusValue) {
    const valid = Array.from(statusMap.keys()).join(", ");
    return `"${statusLabel}" is not a valid lead status. Valid options: ${valid}.`;
  }

  let contact: { id: string; name: string; email: string } | undefined;

  if (contactId) {
    const props = await getObjectProperties("contacts", contactId, [
      "firstname",
      "lastname",
      "email",
    ]);
    const fullName =
      `${props.firstname ?? ""} ${props.lastname ?? ""}`.trim() ||
      "Unknown contact";
    contact = { id: contactId, name: fullName, email: props.email ?? "" };
  } else {
    const matches = await findContactsByName(name);
    if (matches.length === 0) {
      return `No contact found named "${name}".`;
    }
    if (matches.length > 1) {
      const options = matches
        .map(
          (m, i) =>
            `${i + 1}. ${m.name}${m.email ? ` — ${m.email}` : " — (no email)"}${m.company ? ` @ ${m.company}` : ""} (contact_id: ${m.id})`,
        )
        .join("\n");
      return `Multiple contacts match "${name}". Show the user this NUMBERED list (do not show the contact_id) and ask them to reply with just the number. When they pick one, call update_lead_status again with that contact_id and status "${statusLabel}". Do not ask for any other confirmation.\n${options}`;
    }
    contact = matches[0];
  }

  const pending = savePendingLeadStatus({
    contactId: contact.id,
    contactName: contact.name,
    contactEmail: contact.email,
    statusLabel,
    statusValue,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
  });

  await postCard(
    ctx,
    `Lead status update ready for ${contact.name}`,
    buildLeadStatusPreviewBlocks(
      contact.name,
      contact.email,
      statusLabel,
      pending.id,
    ),
  );

  return `Posted an approval card to set ${contact.name}'s lead status to "${statusLabel}". Waiting for the user to Approve or Discard.`;
}

async function runAddProspect(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const firstName = String(args.first_name ?? "").trim();
  if (!firstName) {
    return "Missing first_name.";
  }
  const lastName = String(args.last_name ?? "").trim();
  const companyName = args.company_name
    ? String(args.company_name).trim()
    : undefined;

  const fields: ProspectFields = {};
  for (const key of [
    "email",
    "phone",
    "mobile",
    "title",
    "source",
    "notes",
    "linkedin",
  ] as const) {
    const value = args[key];
    if (value) {
      fields[key] = String(value).trim();
    }
  }

  const displayName = `${firstName} ${lastName}`.trim();
  const pending = savePendingProspect({
    firstName,
    lastName,
    ...(companyName ? { companyName } : {}),
    displayName,
    fields,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });

  await postCard(
    ctx,
    `Prospect ready for ${displayName}`,
    buildProspectPreviewBlocks(displayName, companyName, fields, pending.id),
  );

  return `Posted an approval card to add ${displayName}${companyName ? ` at ${companyName}` : ""} as a prospect. Waiting for the user to Approve or Discard.`;
}

async function runMoveDealStage(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const targetStage = String(args.target_stage ?? "").trim();
  if (!targetStage) {
    return "Missing target_stage.";
  }

  const pipeline = await getPipelineMeta();
  const stage = pipeline.stageByLabel.get(targetStage.toLowerCase());
  if (!stage) {
    const valid = pipeline.stages.map((s) => s.label).join(", ");
    return `"${targetStage}" is not a valid stage. Valid stages: ${valid}.`;
  }

  const companyName = args.company_name
    ? String(args.company_name).trim()
    : undefined;
  const dealName = args.deal_name ? String(args.deal_name).trim() : undefined;

  if (!companyName && !dealName) {
    return "Provide a company_name and/or deal_name to identify the deal.";
  }

  const { ambiguousCompanies, deals } = await resolveDealsForStageMove({
    ...(companyName ? { companyName } : {}),
    ...(dealName ? { dealName } : {}),
  });

  if (ambiguousCompanies && ambiguousCompanies.length > 0) {
    const options = ambiguousCompanies
      .map((c, i) => `${i + 1}. ${c.name}${c.domain ? ` (${c.domain})` : ""}`)
      .join("\n");
    return `Multiple companies matched. Ask the user which one:\n${options}`;
  }

  if (deals.length === 0) {
    return `No deal found for ${companyName ?? dealName}.`;
  }

  if (deals.length > 1) {
    const options = deals
      .map((d, i) => `${i + 1}. ${d.name} — ${d.currentStageLabel}`)
      .join("\n");
    return `Multiple deals matched. Ask the user which one (pass deal_name):\n${options}`;
  }

  const deal = deals[0];
  if (deal.currentStageId === stage.id) {
    return `Deal "${deal.name}" is already in ${stage.label}.`;
  }

  const pending = savePendingStageMove({
    dealId: deal.id,
    dealName: deal.name,
    currentStageLabel: deal.currentStageLabel,
    targetStageId: stage.id,
    targetStageLabel: stage.label,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });

  await postCard(
    ctx,
    `Stage move ready for ${deal.name}`,
    buildStageMovePreviewBlocks(
      deal.name,
      deal.id,
      deal.currentStageLabel,
      stage.label,
      pending.id,
    ),
  );

  return `Posted an approval card to move "${deal.name}" from ${deal.currentStageLabel} to ${stage.label}. Waiting for the user to Approve or Discard.`;
}

async function runDraftEmail(
  ctx: ToolContext,
  contactName: string,
  template: DraftType,
): Promise<string> {
  const contacts = await findContactsByName(contactName);
  if (contacts.length === 0) {
    return `No HubSpot contact matching "${contactName}".`;
  }
  if (contacts.length > 1) {
    const options = contacts
      .map(
        (c, i) =>
          `${i + 1}. ${c.name}${c.company ? ` (${c.company})` : ""}${c.email ? ` — ${c.email}` : ""}`,
      )
      .join("\n");
    return `Multiple contacts matched "${contactName}". Ask the user which one:\n${options}`;
  }

  const preview = await createDraftByContactId(
    contacts[0].id,
    template,
    ctx.userId,
    ctx.channel,
    ctx.threadTs,
  );

  await postCard(
    ctx,
    `Email draft ready for ${preview.context.fullName}`,
    buildEmailDraftPreviewBlocks(
      template,
      preview.context,
      preview.draft.to,
      preview.subject,
      preview.body,
      preview.draft.id,
    ),
  );

  return `Posted an approval card for a ${template} email to ${preview.context.fullName} (${preview.draft.to}). Waiting for the user to Approve or Discard.`;
}

async function runDraftCustomEmail(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const to = String(args.to ?? "").trim();
  const subject = String(args.subject ?? "").trim();
  const body = String(args.body ?? "").trim();
  const contactName = args.contact_name
    ? String(args.contact_name).trim()
    : "";

  if (!to || !subject || !body) {
    return "Missing to, subject, or body.";
  }

  const draft = saveDraft({
    type: "event-follow-up",
    contactId: "",
    dealId: "",
    to,
    subject,
    body,
    contactName: contactName || to,
    companyName: "",
    dealStage: "",
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });

  await postCard(
    ctx,
    `Email draft ready for ${contactName || to}`,
    buildCustomEmailDraftPreviewBlocks(
      to,
      subject,
      body,
      draft.id,
      contactName || undefined,
    ),
  );

  return `Posted an approval card for a custom email to ${to}. Waiting for the user to Approve or Discard.`;
}

async function runScheduleFollowUp(
  ctx: ToolContext,
  name: string,
  days: number,
  note: string,
): Promise<string> {
  const result = await findNoteRecords(name);
  if (Array.isArray(result)) {
    const options = result.map(formatMatch).join("\n");
    return `Multiple records matched "${name}". Ask the user which one:\n${options}`;
  }

  const safeDays = Number.isFinite(days) && days > 0 ? Math.round(days) : 1;
  const dueMs = Date.now() + safeDays * 86_400_000;
  const dueLabel = new Date(dueMs).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  });

  const pending = savePendingReminder({
    recordType: result.type,
    recordId: result.id,
    recordName: result.name,
    note,
    days: safeDays,
    dueMs,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
  });

  await postCard(
    ctx,
    `Reminder ready for ${result.name}`,
    buildReminderPreviewBlocks(
      result.name,
      result.type,
      dueLabel,
      safeDays,
      note,
      pending.id,
    ),
  );

  return `Posted an approval card to remind about ${result.type} "${result.name}" in ${safeDays} day(s) (due ${dueLabel}). Waiting for the user to Approve or Discard.`;
}

async function runSummarizeEmailToNotes(
  ctx: ToolContext,
  contactName: string,
  summary: string,
): Promise<string> {
  const contacts = await findContactsByName(contactName);
  if (contacts.length === 0) {
    return `No HubSpot contact matching "${contactName}".`;
  }
  if (contacts.length > 1) {
    const options = contacts
      .map((c, i) => `${i + 1}. ${c.name}${c.company ? ` (${c.company})` : ""}`)
      .join("\n");
    return `Multiple contacts matched "${contactName}". Ask the user which one:\n${options}`;
  }

  const contact = contacts[0];
  const company = await getAssociatedCompany(contact.id).catch(() => null);

  const contactMatch: NoteRecordMatch = {
    type: "contact",
    id: contact.id,
    name: contact.name,
    detail: contact.email || contact.company || "Contact",
  };
  const contactPending = savePendingNoteUpdate({
    recordType: "contact",
    recordId: contact.id,
    recordName: contact.name,
    recordDetail: contactMatch.detail,
    note: summary,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });
  await postCard(
    ctx,
    `Email summary ready for ${contact.name}`,
    buildNoteUpdatePreviewBlocks(contactMatch, summary, contactPending.id),
  );

  let companyLine = "";
  if (company) {
    const companyMatch: NoteRecordMatch = {
      type: "company",
      id: company.id,
      name: company.name,
      detail: "Company",
    };
    const companyPending = savePendingNoteUpdate({
      recordType: "company",
      recordId: company.id,
      recordName: company.name,
      recordDetail: "Company",
      note: summary,
      createdBy: ctx.userId,
      channelId: ctx.channel,
      threadTs: ctx.threadTs,
    });
    await postCard(
      ctx,
      `Email summary ready for ${company.name}`,
      buildNoteUpdatePreviewBlocks(companyMatch, summary, companyPending.id),
    );
    companyLine = ` and its company "${company.name}"`;
  }

  return `Posted approval card(s) to attach the summary to ${contact.name}${companyLine}. Waiting for the user to Approve or Discard.`;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "get_pipeline_stages": {
      const pipeline = await getPipelineMeta();
      return pipeline.stages
        .map(
          (s, i) =>
            `${i + 1}. ${s.label} (${Math.round(s.probability * 100)}% win)`,
        )
        .join("\n");
    }

    case "get_lead_statuses": {
      const map = await getLeadStatusMap();
      const labels = [...map.keys()];
      return labels.length > 0
        ? labels.join(", ")
        : "No lead statuses configured.";
    }

    case "search_records": {
      const result = await findNoteRecords(String(args.query ?? "")).catch(
        (error: unknown) =>
          error instanceof Error ? error.message : "Search failed",
      );
      if (typeof result === "string") {
        return result;
      }
      const matches = Array.isArray(result) ? result : [result];
      return matches.map(formatMatch).join("\n");
    }

    case "get_company_status": {
      const companyName = String(args.company_name ?? "").trim();
      const matches = await findCompaniesByName(companyName);
      if (matches.length === 0) {
        return `No HubSpot company matching "${companyName}".`;
      }
      if (matches.length > 1) {
        const options = matches
          .map(
            (m, i) => `${i + 1}. ${m.name}${m.domain ? ` — ${m.domain}` : ""}`,
          )
          .join("\n");
        return `Multiple companies matched "${companyName}". Ask the user which one:\n${options}`;
      }
      const status = await getCompanyStatus(matches[0].id);
      await postCard(
        ctx,
        `Current status for ${status.name}`,
        buildCompanyStatusBlocks(status),
      );
      return `Posted a status card for ${status.name}: ${status.deals.length} deal(s), ${status.contacts.length} contact(s), last activity ${status.lastActivity ?? "unknown"}.`;
    }

    case "post_digest": {
      const digest = await buildDailyDigest();
      await ctx.client.chat.postMessage({
        channel: digest.channelId,
        text: "FlairX GTM Daily Digest",
        blocks: digest.blocks,
      });
      return `Posted the daily digest to <#${digest.channelId}>.`;
    }

    case "update_notes":
      return runUpdateNotes(
        ctx,
        String(args.name ?? ""),
        String(args.note ?? ""),
      );

    case "update_lead_status":
      return runUpdateLeadStatus(
        ctx,
        String(args.name ?? ""),
        String(args.status ?? ""),
        args.contact_id ? String(args.contact_id) : "",
      );

    case "add_prospect":
      return runAddProspect(ctx, args);

    case "move_deal_stage":
      return runMoveDealStage(ctx, args);

    case "schedule_follow_up":
      return runScheduleFollowUp(
        ctx,
        String(args.name ?? ""),
        typeof args.days === "number" ? args.days : Number(args.days ?? 0),
        args.note ? String(args.note) : "",
      );

    case "draft_email":
      return runDraftEmail(
        ctx,
        String(args.contact_name ?? ""),
        (String(args.template ?? "") as DraftType) || "event-follow-up",
      );

    case "draft_custom_email":
      return runDraftCustomEmail(ctx, args);

    case "list_unanswered_emails": {
      const days =
        typeof args.days === "number" && args.days > 0 ? args.days : 7;
      const threads = await listThreadsAwaitingReply(days);
      if (threads.length === 0) {
        return `No sent threads without a reply in the last ${days} days.`;
      }
      return threads
        .map(
          (t) =>
            `- thread_id=${t.threadId} · to: ${t.to} · "${t.subject}" · ${t.daysWaiting} days waiting`,
        )
        .join("\n");
    }

    case "get_email_thread": {
      const thread = await getThreadContent(String(args.thread_id ?? ""));
      return `Subject: ${thread.subject}\nParticipants: ${thread.participants.join(", ")}\n\n${thread.text}`;
    }

    case "summarize_email_to_notes":
      return runSummarizeEmailToNotes(
        ctx,
        String(args.contact_name ?? ""),
        String(args.summary ?? ""),
      );

    default:
      return `Unknown tool: ${name}`;
  }
}
