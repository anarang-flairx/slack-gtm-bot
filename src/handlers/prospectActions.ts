import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import { createProspect } from "../integrations/hubspot.js";
import {
  beginProspectAction,
  completeProspectAction,
  releaseProspectAction,
  takeProspect,
} from "../lib/prospectStore.js";
import { postPublic } from "../lib/slackPost.js";

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

async function replaceMessage(
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

export function registerProspectActions(app: App): void {
  app.action("approve_add_prospect", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginProspectAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postPublic(
          client,
          channelId,
          "This prospect preview expired. Run `/add-prospect` again.",
        );
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await postPublic(
          client,
          channelId,
          "Only the person who created this prospect can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;

    try {
      const created = await createProspect({
        firstName: pending.firstName,
        lastName: pending.lastName,
        ...(pending.companyName ? { companyName: pending.companyName } : {}),
        ...pending.fields,
      });
      completeProspectAction(pendingId);

      const contactUrl = hubspotRecordUrl("contact", created.contactId);
      const dealUrl = hubspotRecordUrl("deal", created.dealId);
      const companyPart = created.companyId
        ? ` · company <${hubspotRecordUrl("company", created.companyId)}|${created.companyName}>`
        : "";

      const successText = `Prospect created: contact <${contactUrl}|${created.contactName}> · deal <${dealUrl}|${created.dealName}> (${created.stageLabel})${companyPart}`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postPublic(client, channelId, successText);
      }
    } catch (error) {
      releaseProspectAction(pendingId);

      const message =
        error instanceof Error ? error.message : "Failed to create prospect";

      if (channelId) {
        await postPublic(client, channelId, message);
      }
    }
  });

  app.action("discard_add_prospect", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, userId } = actionContext(body);
    const result = takeProspect(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postPublic(
          client,
          channelId,
          "This prospect preview already expired or was discarded.",
        );
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await postPublic(
          client,
          channelId,
          "Only the person who created this prospect can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Prospect for *${result.pending.displayName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postPublic(client, channelId, discardText);
    }
  });
}
