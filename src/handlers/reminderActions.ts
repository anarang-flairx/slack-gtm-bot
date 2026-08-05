import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import {
  associateTaskToRecord,
  createTask,
} from "../integrations/hubspot.js";
import {
  beginReminderAction,
  completeReminderAction,
  releaseReminderAction,
  takeReminder,
} from "../lib/reminderStore.js";
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

function formatDue(dueMs: number): string {
  return new Date(dueMs).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function registerReminderActions(app: App): void {
  app.action("approve_reminder", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginReminderAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This reminder expired. Mention me again to set it.",
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
          "Only the person who created this reminder can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;
    const subject = `Follow up: ${pending.recordName}${pending.note ? ` — ${pending.note}` : ""}`;

    try {
      const task = await createTask({
        subject,
        dueMs: pending.dueMs,
        ...(pending.note ? { body: pending.note } : {}),
        ...(process.env.HUBSPOT_OWNER_ID
          ? { ownerId: process.env.HUBSPOT_OWNER_ID }
          : {}),
      });
      await associateTaskToRecord(
        task.id,
        pending.recordType,
        pending.recordId,
      );

      // Schedule a Slack nudge; Slack requires post_at in the future.
      const postAt = Math.max(
        Math.floor(pending.dueMs / 1000),
        Math.floor(Date.now() / 1000) + 60,
      );
      const nudge = `:bell: Follow-up reminder for <@${pending.createdBy}>: *${pending.recordName}*${pending.note ? ` — ${pending.note}` : ""}`;
      await client.chat.scheduleMessage({
        channel: pending.channelId,
        post_at: postAt,
        text: nudge,
      });

      completeReminderAction(pendingId);

      const url = hubspotRecordUrl(pending.recordType, pending.recordId);
      const successText = `Reminder set for <${url}|${pending.recordName}> — HubSpot task due ${formatDue(pending.dueMs)} and a Slack nudge scheduled here.`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
    } catch (error) {
      releaseReminderAction(pendingId);
      const message =
        error instanceof Error ? error.message : "Failed to set reminder";
      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_reminder", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeReminder(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This reminder already expired or was discarded.",
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
          "Only the person who created this reminder can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Reminder for *${result.pending.recordName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
