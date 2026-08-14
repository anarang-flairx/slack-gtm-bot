import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type OpenAI from "openai";
import {
  findCompaniesByName,
  findContactByEmail,
  findContactsByName,
  getAssociatedCompany,
  getCompanyLifecycleStageOptions,
  getCompanyStatus,
  getLeadStatusMap,
  getObjectProperties,
  getPipelineMeta,
  findNoteRecords,
  listCompaniesByLifecycleStage,
  listDealPipelines,
  resolveDealsForStageMove,
  type NoteRecordMatch,
} from "../integrations/hubspot.js";
import {
  getThreadContent,
  listThreadsAwaitingReply,
} from "../integrations/gmail.js";
import { buildDailyDigest } from "../digest/buildDailyDigest.js";
import { hubspotRecordUrl } from "../digest/format.js";
import { createDraftByContactId } from "../lib/createDraft.js";
import { saveDraft } from "../lib/draftStore.js";
import { startDealCreate } from "../lib/dealCreateFlow.js";
import { postRecentMarketingCleanup } from "../lib/runMarketingCleanup.js";
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

/** After posting an approval card — model should echo this to the user. */
const CARD_READY =
  "[card ready] User reply only: Review the card above — Approve or Discard.";

/** Marker for a pick that should be shown as-is (not model-restated). */
const PICK_POSTED = "[pick posted]";
const PICK_USER_START = "<<<PICK_USER>>>";
const PICK_USER_END = "<<<END_PICK_USER>>>";

/** Resolve "1" / "2" style picks to a 0-based index item. */
function resolveByNumber<T>(raw: string, items: T[]): T | undefined {
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > items.length) {
    return undefined;
  }
  return items[n - 1];
}

/**
 * Numbered pick — model shows title + list to the user.
 * `hint` and optional `idMap` are for the model only (never show ids to the user).
 * Each option must stay on its own line when echoed.
 */
function pickPrompt(
  title: string,
  lines: string,
  hint: string,
  idMap?: string,
): string {
  const userText = `${title}\n${lines}\n\nReply with a number.`;
  const mapLine = idMap ? `\nids (model only): ${idMap}` : "";
  return (
    `${PICK_POSTED}\n${PICK_USER_START}\n${userText}\n${PICK_USER_END}\n` +
    `[pick] ${hint}${mapLine}`
  );
}

/**
 * Format a numbered pick for Slack. Does not post itself — the agent loop
 * posts the user block once so history can keep the id map for the next turn.
 */
async function postPick(
  _ctx: ToolContext,
  title: string,
  lines: string,
  hint: string,
  idMap?: string,
): Promise<string> {
  return pickPrompt(title, lines, hint, idMap);
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
      name: "get_company_lifecycle_stages",
      description:
        "List the HubSpot company lifecycle stage options (e.g. Lead, Opportunity, Customer). Use before listing companies by stage if the user’s wording is unclear.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_companies_by_lifecycle_stage",
      description:
        "List HubSpot companies in a given lifecycle stage (e.g. Customer, Lead, Opportunity). Use for 'show me all customers' or 'which companies are in the Customer stage'.",
      parameters: {
        type: "object",
        properties: {
          stage: {
            type: "string",
            description: "Lifecycle stage label, e.g. 'Customer'",
          },
        },
        required: ["stage"],
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
        "Post a status card for a company: its deals, contacts, notes (including native HubSpot notes), and last activity. Use ONLY for 'what's the status of X' / status lookups. Do NOT use this for 'move X to deals' or creating a deal — use create_company_deal instead.",
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
        "Build and post the GTM daily digest: scan open HubSpot deals, read each deal's email chain and notes, decide which need a follow-up, and post those with a short why plus a Draft follow-up button.",
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
      name: "add_contact",
      description:
        "Prepare a new HubSpot contact (+ optional company). No deal is created. Checks for an existing contact by email/name first and refuses duplicates. Reuses an exact-match company if one exists. Posts an approval card; records are only created after approval. Use for 'add <person> to HubSpot/contacts', badge scans, and screenshot leads unless the user explicitly asks for a deal or prospect.",
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
          source: {
            type: "string",
            description: "Where you met them (stored in contact notes)",
          },
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
      name: "add_prospect",
      description:
        "Prepare a new HubSpot contact (+ optional company) AND a deal in the Prospecting stage. Checks for existing contacts/companies/deals first and refuses duplicates. Use only when the user explicitly wants a deal/prospect in the pipeline for a *new person* — not for a simple 'add to contacts', and not for creating a deal on an existing company (use create_company_deal for that).",
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
      name: "create_company_deal",
      description:
        "Create a NEW HubSpot deal on an *existing* company. Call with company_name only — do NOT pass pipeline, stage, or relationship_type, and do NOT call get_pipeline_stages. The bot asks pipeline, then that pipeline's stages, then (Partnerships only) relationship type, then posts an Approve/Discard card. Deal name is always '[Company] - FlairX'. Associates company + all contacts. Refuse duplicates unless force=true. Do NOT use move_deal_stage or add_prospect for these requests.",
      parameters: {
        type: "object",
        properties: {
          company_name: {
            type: "string",
            description: "Existing HubSpot company name",
          },
          company_id: {
            type: "string",
            description:
              "HubSpot company id to disambiguate when the name matched multiple companies. Optional.",
          },
          force: {
            type: "boolean",
            description:
              "Set true only when the user explicitly asks to create another deal even though the company already has one(s).",
          },
        },
        required: ["company_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_deal_stage",
      description:
        "Change the pipeline STAGE of an *existing* deal (e.g. Prospecting → Negotiation, or Engaged on Partnerships). NOT for creating deals. NOT for 'move company to deals' / 'add company to pipeline' — those require create_company_deal. Identify the deal by company name, deal name, and/or contact name. Stages are validated against THAT deal's pipeline (Sales vs Partnerships), not a fixed list. Posts an approval card.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string" },
          deal_name: { type: "string" },
          contact_name: {
            type: "string",
            description:
              "Contact associated with the deal (e.g. 'Yogi Chugh'). Use when the user names a person rather than a company.",
          },
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
      name: "cleanup_marketing_records",
      description:
        "Scan HubSpot contacts and companies created in the last 24 hours, classify logged emails/activity as marketing junk, and post a summary plus an Approve/Discard card per record. Never archives without approval. A daily 8am job also posts this automatically.",
      parameters: { type: "object", properties: {} },
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
    return pickPrompt(
      "Pick a record:",
      result.map(formatMatch).join("\n"),
      `update_notes name=<chosen>`,
    );
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

  return CARD_READY;
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
      return pickPrompt(
        "Pick a contact:",
        matches
          .map(
            (m, i) =>
              `${i + 1}. ${m.name}${m.email ? ` — ${m.email}` : ""}${m.company ? ` @ ${m.company}` : ""}`,
          )
          .join("\n"),
        `update_lead_status contact_id=<id> status="${statusLabel}"`,
      );
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

  return CARD_READY;
}

async function runAddPerson(
  ctx: ToolContext,
  args: Record<string, unknown>,
  createDeal: boolean,
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

  // Dedupe contact by email (strongest) then by name.
  if (fields.email) {
    const existingByEmail = await findContactByEmail(fields.email);
    if (existingByEmail) {
      const url = hubspotRecordUrl("contact", existingByEmail.id);
      return `Contact exists: <${url}|${existingByEmail.name}> (${fields.email}). Deal? → create_company_deal.`;
    }
  }

  const nameMatches = await findContactsByName(displayName);
  const sameName = nameMatches.filter(
    (m) => m.name.toLowerCase() === displayName.toLowerCase(),
  );
  if (sameName.length > 0) {
    const lines = sameName
      .map((m) => {
        const url = hubspotRecordUrl("contact", m.id);
        const bits = [m.email, m.company].filter(Boolean).join(" · ");
        return `• <${url}|${m.name}>${bits ? ` — ${bits}` : ""}`;
      })
      .join("\n");
    return `Contact exists:\n${lines}\n→ User: link + ask update notes or skip.`;
  }

  let companyReuseNote: string | undefined;
  if (companyName) {
    const companies = await findCompaniesByName(companyName);
    const exact = companies.find(
      (c) => c.name.toLowerCase() === companyName.toLowerCase(),
    );
    if (exact) {
      const url = hubspotRecordUrl("company", exact.id);
      companyReuseNote = `Company already exists — will reuse <${url}|${exact.name}> (not create a new company).`;

      if (createDeal) {
        const status = await getCompanyStatus(exact.id);
        if (status.deals.length > 0) {
          const dealLines = status.deals
            .map((d) => {
              const dealUrl = hubspotRecordUrl("deal", d.id);
              return `• <${dealUrl}|${d.name}> — ${d.stage}`;
            })
            .join("\n");
          return `${exact.name} has deal(s):\n${dealLines}\n→ add_contact for person only, or create_company_deal force=true.`;
        }
      }
    } else if (companies.length > 0) {
      return pickPrompt(
        "Pick a company:",
        companies
          .map(
            (c, i) =>
              `${i + 1}. ${c.name}${c.domain ? ` — ${c.domain}` : ""}`,
          )
          .join("\n"),
        `reuse chosen company or create "${companyName}"`,
      );
    }
  }

  const pending = savePendingProspect({
    firstName,
    lastName,
    ...(companyName ? { companyName } : {}),
    displayName,
    fields,
    createDeal,
    createdBy: ctx.userId,
    channelId: ctx.channel,
    threadTs: ctx.threadTs,
  });

  const cardLabel = createDeal ? "Prospect" : "Contact";
  await postCard(
    ctx,
    `${cardLabel} ready for ${displayName}`,
    buildProspectPreviewBlocks(
      displayName,
      companyName,
      fields,
      pending.id,
      createDeal,
      companyReuseNote,
    ),
  );

  return CARD_READY;
}

async function runAddProspect(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  return runAddPerson(ctx, args, true);
}

async function runAddContact(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  return runAddPerson(ctx, args, false);
}

async function runCreateCompanyDeal(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const companyName = String(args.company_name ?? "").trim();
  if (!companyName) {
    return "Missing company_name.";
  }

  return startDealCreate(ctx, {
    companyName,
    ...(args.company_id ? { companyId: String(args.company_id).trim() } : {}),
    force: args.force === true,
  });
}

async function runMoveDealStage(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const targetStage = String(args.target_stage ?? "").trim();
  if (!targetStage) {
    return "Missing target_stage.";
  }

  const companyName = args.company_name
    ? String(args.company_name).trim()
    : undefined;
  const dealName = args.deal_name ? String(args.deal_name).trim() : undefined;
  const contactName = args.contact_name
    ? String(args.contact_name).trim()
    : undefined;

  if (!companyName && !dealName && !contactName) {
    return "Provide a company_name, deal_name, and/or contact_name to identify the deal.";
  }

  const { ambiguousCompanies, deals } = await resolveDealsForStageMove({
    ...(companyName ? { companyName } : {}),
    ...(dealName ? { dealName } : {}),
    ...(contactName ? { contactName } : {}),
  });

  if (ambiguousCompanies && ambiguousCompanies.length > 0) {
    return pickPrompt(
      "Pick a company:",
      ambiguousCompanies
        .map((c, i) => `${i + 1}. ${c.name}${c.domain ? ` (${c.domain})` : ""}`)
        .join("\n"),
      `move_deal_stage company_name=<chosen>`,
    );
  }

  if (deals.length === 0) {
    return `No deal for ${contactName ?? companyName ?? dealName}. New deal? → create_company_deal.`;
  }

  if (deals.length > 1) {
    return pickPrompt(
      "Pick a deal:",
      deals
        .map(
          (d, i) =>
            `${i + 1}. ${d.name} — ${d.pipelineLabel} / ${d.currentStageLabel}`,
        )
        .join("\n"),
      `move_deal_stage deal_name=<chosen>`,
    );
  }

  const deal = deals[0];
  const pipeline = await getPipelineMeta(
    deal.pipelineId || process.env.HUBSPOT_PIPELINE_ID,
  );
  const stage = pipeline.stageByLabel.get(targetStage.toLowerCase());
  if (!stage) {
    const valid = pipeline.stages.map((s) => s.label).join(", ");
    return `"${targetStage}" is not a valid stage in the *${pipeline.label}* pipeline (deal: ${deal.name}). Choose from: ${valid}.`;
  }

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
      deal.pipelineLabel || pipeline.label,
    ),
  );

  return CARD_READY;
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
    return pickPrompt(
      "Pick a contact:",
      contacts
        .map(
          (c, i) =>
            `${i + 1}. ${c.name}${c.company ? ` (${c.company})` : ""}${c.email ? ` — ${c.email}` : ""}`,
        )
        .join("\n"),
      `draft_email contact_name=<chosen>`,
    );
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

  return CARD_READY;
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

  return CARD_READY;
}

async function runScheduleFollowUp(
  ctx: ToolContext,
  name: string,
  days: number,
  note: string,
): Promise<string> {
  const result = await findNoteRecords(name);
  if (Array.isArray(result)) {
    return pickPrompt(
      "Pick a record:",
      result.map(formatMatch).join("\n"),
      `schedule_follow_up name=<chosen>`,
    );
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

  return CARD_READY;
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
    return pickPrompt(
      "Pick a contact:",
      contacts
        .map((c, i) => `${i + 1}. ${c.name}${c.company ? ` (${c.company})` : ""}`)
        .join("\n"),
      `summarize_email_to_notes contact_name=<chosen>`,
    );
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
  }

  return CARD_READY;
}

/** Scan last-24h records' email activity and post per-item approval cards. */
export async function runCleanupMarketing(ctx: ToolContext): Promise<string> {
  const lookbackHours = Number(process.env.CLEANUP_LOOKBACK_HOURS ?? 24) || 24;
  const posted = await postRecentMarketingCleanup(ctx);
  if (posted.contacts === 0 && posted.companies === 0) {
    if (posted.skippedExistingCompany > 0) {
      return `No marketing junk to review in the last ${lookbackHours} hours — ${posted.skippedExistingCompany} contact(s) were on companies you already have.`;
    }
    return `No marketing/auto-created junk contacts or companies found in the last ${lookbackHours} hours.`;
  }
  return CARD_READY;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "get_pipeline_stages": {
      const pipelines = await listDealPipelines();
      if (pipelines.length === 0) {
        return "No deal pipelines found in HubSpot.";
      }
      const sections: string[] = [];
      for (const p of pipelines) {
        const meta = await getPipelineMeta(p.id);
        const stages = meta.stages
          .map(
            (s, i) =>
              `${i + 1}. ${s.label} (${Math.round(s.probability * 100)}% win)`,
          )
          .join("\n");
        sections.push(
          `*${meta.label}* (pipeline_id: ${meta.id})\n${stages}`,
        );
      }
      return (
        sections.join("\n\n") +
        "\n\n(For .env: set HUBSPOT_PIPELINE_ID to the Sales pipeline_id, HUBSPOT_PARTNERSHIP_PIPELINE_ID to the Partnerships pipeline_id.)"
      );
    }

    case "get_lead_statuses": {
      const map = await getLeadStatusMap();
      const labels = [...map.keys()];
      return labels.length > 0
        ? labels.join(", ")
        : "No lead statuses configured.";
    }

    case "get_company_lifecycle_stages": {
      const options = await getCompanyLifecycleStageOptions();
      return options.length > 0
        ? options.map((o) => o.label).join(", ")
        : "No company lifecycle stages configured.";
    }

    case "list_companies_by_lifecycle_stage": {
      const stage = String(args.stage ?? "").trim();
      if (!stage) {
        return "Missing lifecycle stage.";
      }
      const companies = await listCompaniesByLifecycleStage(stage);
      if (companies.length === 0) {
        return `No companies found in lifecycle stage "${stage}".`;
      }
      const lines = companies.map((c, i) => {
        const domain = c.domain ? ` — ${c.domain}` : "";
        return `${i + 1}. ${c.name}${domain}`;
      });
      const suffix =
        companies.length >= 50 ? "\n(first 50 — ask to narrow)" : "";
      return `Companies in *${stage}* (${companies.length}):\n${lines.join("\n")}${suffix}`;
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
        return pickPrompt(
          "Pick a company:",
          matches
            .map(
              (m, i) =>
                `${i + 1}. ${m.name}${m.domain ? ` — ${m.domain}` : ""}`,
            )
            .join("\n"),
          `get_company_status company_name=<chosen>`,
        );
      }
      const status = await getCompanyStatus(matches[0].id);
      await postCard(
        ctx,
        `Current status for ${status.name}`,
        buildCompanyStatusBlocks(status),
      );
      const dealHint =
        status.deals.length === 0
          ? " [no deals — create_company_deal if user wants pipeline]"
          : "";
      return `[status card posted] ${status.name}: ${status.deals.length} deal(s), ${status.contacts.length} contact(s).${dealHint} User reply: one short line or silence — card has detail.`;
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

    case "add_contact":
      return runAddContact(ctx, args);

    case "add_prospect":
      return runAddProspect(ctx, args);

    case "create_company_deal":
      return runCreateCompanyDeal(ctx, args);

    case "move_deal_stage":
      return runMoveDealStage(ctx, args);

    case "schedule_follow_up":
      return runScheduleFollowUp(
        ctx,
        String(args.name ?? ""),
        typeof args.days === "number" ? args.days : Number(args.days ?? 0),
        args.note ? String(args.note) : "",
      );

    case "cleanup_marketing_records":
      return runCleanupMarketing(ctx);

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
