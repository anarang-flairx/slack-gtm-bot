import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import { updateDealStage } from "../integrations/hubspot.js";
import {
  beginStageMoveAction,
  completeStageMoveAction,
  releaseStageMoveAction,
  takeStageMove,
} from "../lib/stageMoveStore.js";
import { appendNotesToRecord } from "../lib/updateNotes.js";
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

export function registerStageMoveActions(app: App): void {
  app.action("approve_stage_move", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginStageMoveAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This stage move expired. Mention me again to move the deal.",
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
          "Only the person who requested this move can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;

    try {
      await updateDealStage(pending.dealId, pending.targetStageId);
      await appendNotesToRecord(
        {
          type: "deal",
          id: pending.dealId,
          name: pending.dealName,
          detail: "",
        },
        `Moved to ${pending.targetStageLabel}`,
      );
      completeStageMoveAction(pendingId);

      const url = hubspotRecordUrl("deal", pending.dealId);
      const successText = `Moved deal <${url}|${pending.dealName}> to *${pending.targetStageLabel}*.`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
    } catch (error) {
      releaseStageMoveAction(pendingId);
      const message =
        error instanceof Error ? error.message : "Failed to move deal stage";
      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_stage_move", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeStageMove(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This stage move already expired or was discarded.",
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
          "Only the person who requested this move can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Stage move for *${result.pending.dealName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
