import type { App } from "@slack/bolt";
import { createGmailDraft } from "../integrations/gmail.js";
import { createDraftByContactId } from "../lib/createDraft.js";
import type { DraftType } from "../types/draft.js";

export function registerDigestActions(app: App): void {
  app.action("draft_followup", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const channelId =
      body.type === "block_actions" ? body.channel?.id : undefined;
    const messageTs =
      body.type === "block_actions" ? body.message?.ts : undefined;
    const userId = body.user.id;

    if (!channelId) {
      return;
    }

    try {
      const payload = JSON.parse(action.value) as {
        contact_id?: string;
        template?: string;
      };

      if (!payload.contact_id) {
        throw new Error("Missing contact_id on button");
      }

      const template = (payload.template ?? "event-follow-up") as DraftType;
      const preview = await createDraftByContactId(
        payload.contact_id,
        template,
        userId,
        channelId,
      );

      await createGmailDraft(
        preview.draft.to,
        preview.draft.subject,
        preview.draft.body,
      );

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `✍️ Draft created for *${preview.context.fullName}* (${preview.draft.to}) — open Gmail → Drafts.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create draft";

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `⚠️ ${message}`,
      });
    }
  });
}
