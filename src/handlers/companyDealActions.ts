import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import { createDealForCompany } from "../integrations/hubspot.js";
import {
  beginCompanyDealAction,
  completeCompanyDealAction,
  releaseCompanyDealAction,
  takeCompanyDeal,
} from "../lib/companyDealStore.js";
import { postThread } from "../lib/slackPost.js";

function actionContext(body: {
  type: string;
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; blocks?: KnownBlock[] };
  user: { id: string };
}) {
  return {
    channelId: body.type === "block_actions" ? body.channel?.id : undefined,
    messageTs: body.type === "block_actions" ? body.message?.ts : undefined,
    threadTs:
      body.type === "block_actions"
        ? (body.message?.thread_ts ?? body.message?.ts)
        : undefined,
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
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
}

export function registerCompanyDealActions(app: App): void {
  app.action("approve_create_company_deal", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginCompanyDealAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This company deal preview expired. Mention me again to create the deal.",
        );
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "Only the person who requested this deal can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;

    try {
      const created = await createDealForCompany({
        companyId: pending.companyId,
        companyName: pending.companyName,
        contactIds: pending.contacts.map((c) => c.id),
        stageLabel: pending.stageLabel,
        force: pending.force === true,
      });
      completeCompanyDealAction(pendingId);

      const dealUrl = hubspotRecordUrl("deal", created.dealId);
      const companyUrl = hubspotRecordUrl("company", created.companyId);
      const contactCount = created.associatedContactIds.length;
      const successText = `Deal created: <${dealUrl}|${created.dealName}> (${created.stageLabel}) · company <${companyUrl}|${created.companyName}> · ${contactCount} contact${contactCount === 1 ? "" : "s"} associated`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
    } catch (error) {
      releaseCompanyDealAction(pendingId);
      const message =
        error instanceof Error ? error.message : "Failed to create company deal";
      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_create_company_deal", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeCompanyDeal(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This company deal preview already expired or was discarded.",
        );
      }
      return;
    }

    if (result.status === "forbidden") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "Only the person who requested this deal can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Deal for *${result.pending.companyName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
