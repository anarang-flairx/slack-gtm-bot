import type { App } from "@slack/bolt";
import { createGmailDraft } from "../integrations/gmail.js";
import { deleteDraft, getDraft } from "../lib/draftStore.js";

export function registerEmailActions(app: App): void {
  app.action("approve_email_draft", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const draft = getDraft(action.value);
    const channelId =
      body.type === "block_actions" ? body.channel?.id : undefined;
    const userId = body.user.id;

    if (!draft) {
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "This draft expired. Run the slash command again.",
        });
      }
      return;
    }

    try {
      await createGmailDraft(draft.to, draft.subject, draft.body);
      deleteDraft(draft.id);

      if (channelId) {
        await client.chat.postMessage({
          channel: channelId,
          text: `Gmail draft created for *${draft.contactName}* (${draft.to}). Open Gmail → Drafts to review and send.`,
        });
      }
    } catch (error) {
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

    deleteDraft(action.value);

    const channelId =
      body.type === "block_actions" ? body.channel?.id : undefined;

    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        text: "Draft discarded.",
      });
    }
  });
}
