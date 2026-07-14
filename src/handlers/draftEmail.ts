import type { KnownBlock } from "@slack/types";
import type { App } from "@slack/bolt";
import {
  findContactContext,
  toTemplateContext,
  type HubSpotContactContext,
} from "../integrations/hubspot.js";
import { fillTemplate, loadTemplate } from "../lib/templateEngine.js";
import { saveDraft } from "../lib/draftStore.js";
import type { DraftType } from "../types/draft.js";

const TEMPLATE_FILES: Record<DraftType, string> = {
  initial: "initial-draft.md",
  "follow-up": "follow-up-draft.md",
};

function truncate(text: string, max = 2800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n...(truncated in preview)`;
}

function buildPreviewBlocks(
  draftType: DraftType,
  context: HubSpotContactContext,
  to: string,
  subject: string,
  body: string,
  draftId: string,
): KnownBlock[] {
  const commandLabel =
    draftType === "initial" ? "/initial-draft" : "/follow-up-draft";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Email draft (${commandLabel})`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*To:*\n${to}` },
        { type: "mrkdwn", text: `*Contact:*\n${context.fullName}` },
        { type: "mrkdwn", text: `*Company:*\n${context.companyName || "—"}` },
        { type: "mrkdwn", text: `*Deal stage:*\n${context.dealStage}` },
        { type: "mrkdwn", text: `*Event / lead source:*\n${context.leadSource}` },
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

async function handleDraftCommand(
  draftType: DraftType,
  contactName: string,
  userId: string,
  channelId: string,
  client: App["client"],
): Promise<void> {
  if (!contactName) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Please provide a contact name. Example: `/initial-draft Jane Doe`",
    });
    return;
  }

  const result = await findContactContext(contactName);

  if (Array.isArray(result)) {
    const options = result
      .map(
        (contact, index) =>
          `${index + 1}. ${contact.fullName} — ${contact.companyName || "No company"} (${contact.dealStage})`,
      )
      .join("\n");

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Multiple contacts matched "${contactName}". Be more specific:\n${options}`,
    });
    return;
  }

  const template = loadTemplate(TEMPLATE_FILES[draftType]);
  const filled = fillTemplate(template, toTemplateContext(result));

  const draft = saveDraft({
    type: draftType,
    contactId: result.contactId,
    dealId: result.dealId,
    to: result.email,
    subject: filled.subject,
    body: filled.body,
    contactName: result.fullName,
    companyName: result.companyName,
    dealStage: result.dealStage,
    createdBy: userId,
    channelId,
  });

  await client.chat.postMessage({
    channel: channelId,
    text: `Email draft ready for ${result.fullName}`,
    blocks: buildPreviewBlocks(
      draftType,
      result,
      result.email,
      filled.subject,
      filled.body,
      draft.id,
    ),
  });
}

export function registerDraftCommands(app: App): void {
  app.command("/initial-draft", async ({ command, ack, client }) => {
    await ack();

    try {
      await handleDraftCommand(
        "initial",
        command.text.trim(),
        command.user_id,
        command.channel_id,
        client,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create draft";

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: message,
      });
    }
  });

  app.command("/follow-up-draft", async ({ command, ack, client }) => {
    await ack();

    try {
      await handleDraftCommand(
        "follow-up",
        command.text.trim(),
        command.user_id,
        command.channel_id,
        client,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create draft";

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: message,
      });
    }
  });
}
