import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { createGmailDraft } from "../integrations/gmail.js";
import {
  beginDraftAction,
  completeDraftAction,
  releaseDraftAction,
  takeDraft,
} from "../lib/draftStore.js";

function actionContext(body: {
  type: string;
  channel?: { id?: string };
  message?: { ts?: string; blocks?: KnownBlock[] };
  user: { id: string };
}) {
  return {
    channelId: body.type === "block_actions" ? body.channel?.id : undefined,
    messageTs: body.type === "block_actions" ? body.message?.ts : undefined,
    userId: body.user.id,
  };
}

async function replaceDraftMessage(
  client: App["client"],
  channelId: string | undefined,
  messageTs: string | undefined,
  text: string,
): Promise<void> {
  if (!channelId || !messageTs) {
    return;
  }

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ],
  });
}

export function registerEmailActions(app: App): void {
  app.action("approve_email_draft", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, userId } = actionContext(body);
    const draftId = action.value;
    const result = beginDraftAction(draftId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "This draft expired. Run the slash command again.",
        });
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "Only the person who created this draft can approve or discard it.",
        });
      }
      return;
    }

    const draft = result.draft;

    try {
      await createGmailDraft(draft.to, draft.subject, draft.body);
      completeDraftAction(draftId);

      const successText = `Gmail draft created for *${draft.contactName}* (${draft.to}). Open Gmail → Drafts to review and send.`;
      await replaceDraftMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await client.chat.postMessage({
          channel: channelId,
          text: successText,
        });
      }
    } catch (error) {
      releaseDraftAction(draftId);

      const message =
        error instanceof Error ? error.message : "Failed to create Gmail draft";

      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: message,
        });
      }
    }
  });

  app.action("discard_email_draft", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, userId } = actionContext(body);
    const result = takeDraft(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "This draft already expired or was discarded.",
        });
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "Only the person who created this draft can approve or discard it.",
        });
      }
      return;
    }

    const discardText = `Draft for *${result.draft.contactName}* discarded.`;
    await replaceDraftMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await client.chat.postMessage({
        channel: channelId,
        text: discardText,
      });
    }
  });
}
