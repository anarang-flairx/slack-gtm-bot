import type { KnownBlock } from "@slack/types";
import type { App } from "@slack/bolt";
import {
  formatProspectFields,
  parseProspectText,
  PROSPECT_USAGE,
  type ProspectFields,
} from "../lib/parseProspect.js";
import { savePendingProspect } from "../lib/prospectStore.js";
import { postPublic } from "../lib/slackPost.js";

function buildPreviewBlocks(
  displayName: string,
  companyName: string | undefined,
  fields: ProspectFields,
  pendingId: string,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Add prospect preview",
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Contact:*\n${displayName}`,
        },
        {
          type: "mrkdwn",
          text: `*Company:*\n${companyName || "— (contact + deal only)"}`,
        },
        {
          type: "mrkdwn",
          text: `*Deal stage:*\nProspecting`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Details*\n${formatProspectFields(fields)}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: companyName
          ? "On approve: create HubSpot *contact*, *company* (or reuse exact name match), and *deal* in Prospecting, then associate them."
          : "On approve: create HubSpot *contact* and *deal* in Prospecting, then associate them.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → HubSpot" },
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

export function registerAddProspectCommand(app: App): void {
  app.command("/add-prospect", async ({ command, ack, client }) => {
    await ack();

    try {
      const parsed = parseProspectText(command.text);
      if (!parsed) {
        await postPublic(client, command.channel_id, PROSPECT_USAGE);
        return;
      }

      const pending = savePendingProspect({
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        ...(parsed.companyName ? { companyName: parsed.companyName } : {}),
        displayName: parsed.displayName,
        fields: parsed.fields,
        createdBy: command.user_id,
        channelId: command.channel_id,
      });

      await postPublic(
        client,
        command.channel_id,
        `Prospect ready for ${parsed.displayName}`,
        buildPreviewBlocks(
          parsed.displayName,
          parsed.companyName,
          parsed.fields,
          pending.id,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to parse prospect";
      await postPublic(client, command.channel_id, message);
    }
  });
}
