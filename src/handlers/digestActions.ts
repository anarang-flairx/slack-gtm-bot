import type { App } from "@slack/bolt";
import { createDraftByContactId } from "../lib/createDraft.js";
import type { DraftType } from "../types/draft.js";
import { buildPreviewBlocks } from "./draftEmail.js";

const DRAFT_TYPES = new Set<DraftType>(["intro", "event-follow-up"]);

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
      if (!DRAFT_TYPES.has(template)) {
        throw new Error(`Unknown template: ${template}`);
      }

      const preview = await createDraftByContactId(
        payload.contact_id,
        template,
        userId,
        channelId,
      );

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Email draft ready for ${preview.context.fullName}`,
        blocks: buildPreviewBlocks(
          template,
          preview.context,
          preview.draft.to,
          preview.draft.subject,
          preview.draft.body,
          preview.draft.id,
        ),
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
