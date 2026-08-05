import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import type { NoteRecordMatch } from "../integrations/hubspot.js";
import {
  beginNoteUpdateAction,
  completeNoteUpdateAction,
  releaseNoteUpdateAction,
  takeNoteUpdate,
} from "../lib/noteUpdateStore.js";
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
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
    ],
  });
}

export function registerNoteActions(app: App): void {
  app.action("approve_notes_update", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginNoteUpdateAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This notes update expired. Mention me again to update the note.",
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
          "Only the person who created this update can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;
    const match: NoteRecordMatch = {
      type: pending.recordType,
      id: pending.recordId,
      name: pending.recordName,
      detail: pending.recordDetail,
    };

    try {
      await appendNotesToRecord(match, pending.note);
      completeNoteUpdateAction(pendingId);

      const url = hubspotRecordUrl(match.type, match.id);
      const successText = `Notes updated on ${match.type} <${url}|${match.name}>.`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
    } catch (error) {
      releaseNoteUpdateAction(pendingId);

      const message =
        error instanceof Error ? error.message : "Failed to update notes";

      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_notes_update", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeNoteUpdate(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This notes update already expired or was discarded.",
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
          "Only the person who created this update can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Notes update for *${result.pending.recordName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
