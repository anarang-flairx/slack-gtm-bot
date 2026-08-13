import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import type {
  CompanyStatus,
  HubSpotContactContext,
  NoteRecordMatch,
} from "../integrations/hubspot.js";
import { appendDatedNote } from "./noteProperties.js";
import { formatProspectFields, type ProspectFields } from "./parseProspect.js";
import type { DraftType } from "../types/draft.js";

function truncate(text: string, max = 2800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n...(truncated in preview)`;
}

export function buildNoteUpdatePreviewBlocks(
  match: NoteRecordMatch,
  note: string,
  pendingId: string,
): KnownBlock[] {
  const url = hubspotRecordUrl(match.type, match.id);
  const previewLine = appendDatedNote("", note);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Update notes preview" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Record:*\n<${url}|${match.name}>` },
        { type: "mrkdwn", text: `*Type:*\n${match.type}` },
        { type: "mrkdwn", text: `*Detail:*\n${match.detail || "—"}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note to append:*\n\`\`\`${truncate(previewLine)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → HubSpot" },
          style: "primary",
          action_id: "approve_notes_update",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_notes_update",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildProspectPreviewBlocks(
  displayName: string,
  companyName: string | undefined,
  fields: ProspectFields,
  pendingId: string,
  createDeal = false,
  companyReuseNote?: string,
): KnownBlock[] {
  const header = createDeal ? "Add prospect preview" : "Add contact preview";
  const approveLabel = createDeal
    ? "Approve → create prospect"
    : "Approve → add contact";

  const fieldsSection: KnownBlock[] = createDeal
    ? [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Contact:*\n${displayName}` },
            {
              type: "mrkdwn",
              text: `*Company:*\n${companyName || "— (contact + deal only)"}`,
            },
            {
              type: "mrkdwn",
              text: `*Deal name:*\n${companyName ? `${companyName} - FlairX` : `${displayName} - FlairX`}`,
            },
            { type: "mrkdwn", text: `*Deal stage:*\nProspecting` },
          ],
        },
      ]
    : [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Contact:*\n${displayName}` },
            {
              type: "mrkdwn",
              text: `*Company:*\n${companyName || "—"}`,
            },
          ],
        },
      ];

  const approveText = createDeal
    ? companyName
      ? "On approve: create HubSpot *contact*, *company* (or reuse exact name match), and *deal* named `[Company] - FlairX` in Prospecting, then associate them."
      : "On approve: create HubSpot *contact* and *deal* named `[Contact] - FlairX` in Prospecting, then associate them."
    : companyName
      ? "On approve: create HubSpot *contact* and *company* (or reuse exact name match), then associate them. No deal is created."
      : "On approve: create HubSpot *contact* only. No deal is created.";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: header },
    },
    ...fieldsSection,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Details*\n${formatProspectFields(fields)}`,
      },
    },
    ...(companyReuseNote
      ? [
          {
            type: "section" as const,
            text: { type: "mrkdwn" as const, text: companyReuseNote },
          },
        ]
      : []),
    {
      type: "section",
      text: { type: "mrkdwn", text: approveText },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: approveLabel },
          style: "primary",
          action_id: "approve_add_prospect",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_add_prospect",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildEmailDraftPreviewBlocks(
  draftType: DraftType,
  context: HubSpotContactContext,
  to: string,
  subject: string,
  body: string,
  draftId: string,
): KnownBlock[] {
  const label = draftType === "intro" ? "intro" : "event follow-up";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Email draft (${label})` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*To:*\n${to}` },
        { type: "mrkdwn", text: `*Contact:*\n${context.fullName}` },
        { type: "mrkdwn", text: `*Company:*\n${context.companyName || "—"}` },
        { type: "mrkdwn", text: `*Deal stage:*\n${context.dealStage}` },
        {
          type: "mrkdwn",
          text: `*Event / lead source:*\n${context.leadSource}`,
        },
        { type: "mrkdwn", text: `*Subject:*\n${subject}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Body preview:*\n\`\`\`${truncate(body)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → Gmail Drafts" },
          style: "primary",
          action_id: "approve_email_draft",
          value: draftId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_email_draft",
          value: draftId,
        },
      ],
    },
  ];
}

export function buildCustomEmailDraftPreviewBlocks(
  to: string,
  subject: string,
  body: string,
  draftId: string,
  contactName?: string,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Email draft (custom)" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*To:*\n${to}` },
        { type: "mrkdwn", text: `*Contact:*\n${contactName || "—"}` },
        { type: "mrkdwn", text: `*Subject:*\n${subject}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Body preview:*\n\`\`\`${truncate(body)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → Gmail Drafts" },
          style: "primary",
          action_id: "approve_email_draft",
          value: draftId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_email_draft",
          value: draftId,
        },
      ],
    },
  ];
}

export function buildStageMovePreviewBlocks(
  dealName: string,
  dealId: string,
  currentStageLabel: string,
  targetStageLabel: string,
  pendingId: string,
): KnownBlock[] {
  const url = hubspotRecordUrl("deal", dealId);
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Move deal stage preview" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Deal:*\n<${url}|${dealName}>` },
        {
          type: "mrkdwn",
          text: `*Stage:*\n${currentStageLabel} → *${targetStageLabel}*`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "On approve: update the deal stage in HubSpot and log a dated note so the activity date refreshes.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → HubSpot" },
          style: "primary",
          action_id: "approve_stage_move",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_stage_move",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildCompanyDealPreviewBlocks(
  companyName: string,
  companyId: string,
  dealName: string,
  pipelineLabel: string,
  stageLabel: string,
  companyFieldKind: "relationship" | "none",
  contacts: Array<{ id: string; name: string; email: string }>,
  pendingId: string,
  existingDeals?: Array<{ id: string; name: string; stage: string }>,
  companyFieldLabel?: string,
): KnownBlock[] {
  const approveDetail =
    companyFieldKind === "relationship"
      ? "On approve: create the HubSpot *deal*, associate the *company* + *all* listed contacts, and set the company *relationship type*."
      : "On approve: create the HubSpot *deal* and associate the *company* + *all* listed contacts.";
  const companyUrl = hubspotRecordUrl("company", companyId);
  const contactLines =
    contacts.length === 0
      ? "_No contacts on this company yet — deal will be associated to the company only._"
      : contacts
          .map((contact) => {
            const url = hubspotRecordUrl("contact", contact.id);
            const email = contact.email ? ` · ${contact.email}` : "";
            return `• <${url}|${contact.name}>${email}`;
          })
          .join("\n");

  const existingDealLines =
    existingDeals && existingDeals.length > 0
      ? existingDeals
          .map((deal) => {
            const url = hubspotRecordUrl("deal", deal.id);
            return `• <${url}|${deal.name}> — ${deal.stage}`;
          })
          .join("\n")
      : "";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Create company deal preview" },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Company:*\n<${companyUrl}|${companyName}>`,
        },
        { type: "mrkdwn", text: `*Deal name:*\n${dealName}` },
        { type: "mrkdwn", text: `*Pipeline:*\n${pipelineLabel}` },
        { type: "mrkdwn", text: `*Deal stage:*\n${stageLabel}` },
        ...(companyFieldKind === "relationship" && companyFieldLabel
          ? [
              {
                type: "mrkdwn" as const,
                text: `*Relationship type:*\n${companyFieldLabel}`,
              },
            ]
          : []),
        {
          type: "mrkdwn",
          text: `*Contacts to associate:*\n${contacts.length}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Contacts*\n${contactLines}`,
      },
    },
    ...(existingDealLines
      ? [
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: `*Existing deals (creating another anyway)*\n${existingDealLines}`,
            },
          },
        ]
      : []),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: approveDetail,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → create deal" },
          style: "primary",
          action_id: "approve_create_company_deal",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_create_company_deal",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildLeadStatusPreviewBlocks(
  contactName: string,
  contactEmail: string,
  statusLabel: string,
  pendingId: string,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Lead status update preview" },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Contact:*\n${contactName}${contactEmail ? ` (${contactEmail})` : ""}`,
        },
        { type: "mrkdwn", text: `*New lead status:*\n${statusLabel}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → update status" },
          style: "primary",
          action_id: "approve_lead_status",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_lead_status",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildReminderPreviewBlocks(
  recordName: string,
  recordType: NoteRecordMatch["type"],
  dueLabel: string,
  days: number,
  note: string,
  pendingId: string,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Follow-up reminder preview" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Record:*\n${recordName} (${recordType})` },
        { type: "mrkdwn", text: `*When:*\nin ${days} day(s) — ${dueLabel}` },
      ],
    },
    ...(note
      ? ([
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Note:*\n${note}` },
          },
        ] as KnownBlock[])
      : []),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "On approve: create a HubSpot task due then and schedule a Slack nudge in this channel.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → set reminder" },
          style: "primary",
          action_id: "approve_reminder",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_reminder",
          value: pendingId,
        },
      ],
    },
  ];
}

function truncateInline(text: string, max = 300): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

export function buildCompanyStatusBlocks(status: CompanyStatus): KnownBlock[] {
  const companyUrl = hubspotRecordUrl("company", status.id);
  const dealLines =
    status.deals.length === 0
      ? "_No associated deals_"
      : status.deals
          .map((deal) => {
            const url = hubspotRecordUrl("deal", deal.id);
            const amount = deal.amount ? ` · $${deal.amount}` : "";
            const close = deal.closeDate ? ` · close ${deal.closeDate}` : "";
            return `• <${url}|${deal.name}> — ${deal.stage}${amount}${close}`;
          })
          .join("\n");

  const contactLines =
    status.contacts.length === 0
      ? "_No associated contacts_"
      : status.contacts
          .map((contact) => {
            const url = hubspotRecordUrl("contact", contact.id);
            const bits = [
              contact.jobTitle,
              contact.email,
              contact.leadStatus,
            ].filter(Boolean);
            return `• <${url}|${contact.name}>${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
          })
          .join("\n");

  const notesPreview = status.notes
    ? truncateInline(status.notes, 500)
    : "_No bot notes_";

  const nativeNotesPreview =
    status.nativeNotes.length === 0
      ? "_No HubSpot notes_"
      : status.nativeNotes
          .slice(0, 3)
          .map((note) => {
            const date = note.timestampMs
              ? new Date(note.timestampMs).toISOString().slice(0, 10)
              : "—";
            return `• [${date}] ${truncateInline(note.body || "(empty note)")}`;
          })
          .join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Status: ${status.name}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Company:*\n<${companyUrl}|${status.name}>` },
        { type: "mrkdwn", text: `*Domain:*\n${status.domain || "—"}` },
        {
          type: "mrkdwn",
          text: `*Last activity:*\n${status.lastActivity || "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Deals / contacts:*\n${status.deals.length} · ${status.contacts.length}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Deals*\n${dealLines}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Contacts*\n${contactLines}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Bot notes*\n${notesPreview}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*HubSpot notes (incl. Codex)*\n${nativeNotesPreview}`,
      },
    },
  ];
}

export function buildCleanupSummaryBlocks(
  contacts: Array<{ id: string; name: string; email: string; reason: string }>,
  companies: Array<{ id: string; name: string; domain: string; reason: string }>,
  windowLabel: string,
  truncated: boolean,
): KnownBlock[] {
  const contactLines =
    contacts.length === 0
      ? "_None_"
      : contacts
          .slice(0, 20)
          .map((c) => {
            const url = hubspotRecordUrl("contact", c.id);
            const email = c.email ? ` · ${c.email}` : "";
            return `• <${url}|${c.name}>${email} — ${c.reason}`;
          })
          .join("\n");
  const companyLines =
    companies.length === 0
      ? "_None_"
      : companies
          .slice(0, 20)
          .map((c) => {
            const url = hubspotRecordUrl("company", c.id);
            const domain = c.domain ? ` · ${c.domain}` : "";
            return `• <${url}|${c.name}>${domain} — ${c.reason}`;
          })
          .join("\n");
  const truncateNote = truncated
    ? "\n_Scan capped — run cleanup again after approving to continue._"
    : "";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Daily marketing cleanup" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Found *${contacts.length}* contact(s) and *${companies.length}* company(ies) created in the *${windowLabel}* whose logged emails/activity look like marketing junk.` +
          truncateNote +
          "\nApprove or discard each card below.",
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Contacts*\n${contactLines}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Companies*\n${companyLines}` },
    },
  ];
}

export function buildCleanupItemPreviewBlocks(
  kind: "contact" | "company",
  item: {
    id: string;
    name: string;
    email?: string;
    domain?: string;
    reason: string;
    summary?: string;
    activitySnippet?: string;
  },
  pendingId: string,
): KnownBlock[] {
  const url =
    kind === "contact"
      ? hubspotRecordUrl("contact", item.id)
      : hubspotRecordUrl("company", item.id);
  const extra =
    kind === "contact"
      ? item.email || "—"
      : item.domain || "—";
  const summary = item.summary?.trim() || item.reason;
  const activity = item.activitySnippet?.trim() || "No logged email body.";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text:
          kind === "contact"
            ? "Cleanup contact"
            : "Cleanup company",
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${kind === "contact" ? "Contact" : "Company"}:*\n<${url}|${item.name}>` },
        {
          type: "mrkdwn",
          text: `*${kind === "contact" ? "Email" : "Domain"}:*\n${extra}`,
        },
        { type: "mrkdwn", text: `*Why:*\n${item.reason}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary*\n${summary}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Activity*\n${activity}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "On approve: *archive* this record in HubSpot (recycle bin, restorable ~90 days).",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → archive" },
          style: "primary",
          action_id: "approve_cleanup_marketing",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_cleanup_marketing",
          value: pendingId,
        },
      ],
    },
  ];
}

export function buildCleanupPreviewBlocks(
  contacts: Array<{
    id: string;
    name: string;
    email: string;
    reason: string;
  }>,
  companies: Array<{
    id: string;
    name: string;
    domain: string;
    reason: string;
  }>,
  pendingId: string,
  truncated: boolean,
  options: { windowLabel?: string } = {},
): KnownBlock[] {
  const maxLines = 15;
  const contactLines =
    contacts.length === 0
      ? "_None_"
      : contacts
          .slice(0, maxLines)
          .map((c) => {
            const url = hubspotRecordUrl("contact", c.id);
            const email = c.email ? ` · ${c.email}` : "";
            return `• <${url}|${c.name}>${email}`;
          })
          .join("\n") +
        (contacts.length > maxLines
          ? `\n_…and ${contacts.length - maxLines} more_`
          : "");

  const companyLines =
    companies.length === 0
      ? "_None_"
      : companies
          .slice(0, maxLines)
          .map((c) => {
            const url = hubspotRecordUrl("company", c.id);
            const domain = c.domain ? ` · ${c.domain}` : "";
            return `• <${url}|${c.name}>${domain}`;
          })
          .join("\n") +
        (companies.length > maxLines
          ? `\n_…and ${companies.length - maxLines} more_`
          : "");

  const truncateNote = truncated
    ? "\n_Scan capped — run cleanup again after approving to continue._"
    : "";
  const windowNote = options.windowLabel
    ? ` Created in the *${options.windowLabel}*.`
    : "";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Marketing cleanup preview" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Archive *${contacts.length}* contact(s) and *${companies.length}* company(ies) that look like inbound marketing / Conversations auto-creates (0 deals).` +
          windowNote +
          truncateNote,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Contacts*\n${contactLines}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Companies*\n${companyLines}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "On approve: *archive* these records in HubSpot (recycle bin, restorable ~90 days). Skips anything with deals.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → archive" },
          style: "primary",
          action_id: "approve_cleanup_marketing",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_cleanup_marketing",
          value: pendingId,
        },
      ],
    },
  ];
}
