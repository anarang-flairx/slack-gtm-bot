import type { App } from "@slack/bolt";
import { createDealFollowUpDraft } from "../lib/dealFollowUpDraft.js";
import { createDraftByContactId } from "../lib/createDraft.js";
import type { DraftType } from "../types/draft.js";
import {
  buildCustomEmailDraftPreviewBlocks,
  buildEmailDraftPreviewBlocks,
} from "../lib/previews.js";

const DRAFT_TYPES = new Set<DraftType>(["intro", "event-follow-up"]);

export function registerDigestActions(app: App): void {
  app.action("draft_deal_followup", async ({ ack, body, action, client }) => {
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
      const payload = JSON.parse(action.value) as { deal_id?: string };
      if (!payload.deal_id) {
        throw new Error("Missing deal_id on button");
      }

      const working = await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: "⏳ Drafting a follow-up from this deal's activity…",
      });

      try {
        const preview = await createDealFollowUpDraft(
          payload.deal_id,
          userId,
          channelId,
          messageTs,
        );

        await client.chat.update({
          channel: channelId,
          ts: working.ts!,
          text: `Email draft ready for ${preview.contactName}`,
          blocks: buildCustomEmailDraftPreviewBlocks(
            preview.to,
            preview.subject,
            preview.body,
            preview.draft.id,
            preview.contactName,
          ),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create draft";
        await client.chat.update({
          channel: channelId,
          ts: working.ts!,
          text: `⚠️ ${message}`,
        });
      }
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
        messageTs,
      );

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Email draft ready for ${preview.context.fullName}`,
        blocks: buildEmailDraftPreviewBlocks(
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
