import type { KnownBlock } from "@slack/types";
import type { App } from "@slack/bolt";
import { hubspotRecordUrl } from "../digest/format.js";
import {
  findCompaniesByName,
  getCompanyStatus,
  type CompanyStatus,
} from "../integrations/hubspot.js";
import { postPublic } from "../lib/slackPost.js";

function truncate(text: string, max = 500): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function buildStatusBlocks(status: CompanyStatus): KnownBlock[] {
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
    ? truncate(status.notes)
    : "_No company notes_";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Status: ${status.name}`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Company:*\n<${companyUrl}|${status.name}>`,
        },
        {
          type: "mrkdwn",
          text: `*Domain:*\n${status.domain || "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Last activity:*\n${status.activityDate || "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Deals / contacts:*\n${status.deals.length} · ${status.contacts.length}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Deals*\n${dealLines}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Contacts*\n${contactLines}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Company notes*\n${notesPreview}`,
      },
    },
  ];
}

export function registerCurrentStatusCommand(app: App): void {
  app.command("/current-status", async ({ command, ack, client }) => {
    await ack();

    const companyName = command.text.trim();
    if (!companyName) {
      await postPublic(
        client,
        command.channel_id,
        "Usage: `/current-status Acme Corp`",
      );
      return;
    }

    try {
      const matches = await findCompaniesByName(companyName);

      if (matches.length === 0) {
        await postPublic(
          client,
          command.channel_id,
          `No HubSpot company matching "${companyName}".`,
        );
        return;
      }

      if (matches.length > 1) {
        const options = matches
          .map((m, i) => {
            const url = hubspotRecordUrl("company", m.id);
            return `${i + 1}. <${url}|${m.name}>${m.domain ? ` — ${m.domain}` : ""}`;
          })
          .join("\n");
        await postPublic(
          client,
          command.channel_id,
          `Multiple companies matched "${companyName}". Be more specific:\n${options}`,
        );
        return;
      }

      const status = await getCompanyStatus(matches[0].id);
      await postPublic(
        client,
        command.channel_id,
        `Current status for ${status.name}`,
        buildStatusBlocks(status),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load company status";
      await postPublic(client, command.channel_id, message);
    }
  });
}
