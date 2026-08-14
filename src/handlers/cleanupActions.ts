import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { archiveMarketingJunk } from "../integrations/hubspot.js";
import {
  beginCleanupAction,
  completeCleanupAction,
  releaseCleanupAction,
  takeCleanup,
} from "../lib/cleanupStore.js";
import { addToNeverLog } from "../lib/neverLogStore.js";
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

export function registerCleanupActions(app: App): void {
  app.action("approve_cleanup_marketing", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginCleanupAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This cleanup preview expired. Say *cleanup* again to rescan.",
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
          "Only the person who requested this cleanup can approve or discard it (daily auto-posts can be approved by anyone).",
        );
      }
      return;
    }

    const pending = result.pending;

    try {
      const archived = await archiveMarketingJunk({
        contactIds: pending.contacts.map((c) => c.id),
        companyIds: pending.companies.map((c) => c.id),
      });
      completeCleanupAction(pendingId);

      // Only suppress future logging for senders we actually archived.
      let neverLogNote = "";
      if (
        archived.archivedCompanies > 0 &&
        (pending.neverLogEmails?.length || pending.neverLogDomains?.length)
      ) {
        try {
          const neverLog = await addToNeverLog({
            emails: pending.neverLogEmails ?? [],
            domains: pending.neverLogDomains ?? [],
          });
          const added = neverLog.emails.length + neverLog.domains.length;
          if (added > 0) {
            neverLogNote = ` Never Log += ${neverLog.emails.length} email(s), ${neverLog.domains.length} domain(s).`;
          }
        } catch (error) {
          console.error("[cleanup] never-log update failed:", error);
        }
      }

      const errorNote =
        archived.errors.length > 0
          ? ` · ${archived.errors.length} error(s)`
          : "";
      const successText =
        pending.kind === "unnamed-company"
          ? `Archived unnamed company and *${archived.archivedContacts}* contact(s).${errorNote}${neverLogNote}`
          : pending.contacts.length === 1 && pending.companies.length === 0
            ? `Archived contact *${pending.contacts[0].name}*.${errorNote}`
            : pending.companies.length === 1 && pending.contacts.length === 0
              ? `Archived company *${pending.companies[0].name}*.${errorNote}`
              : `Archived *${archived.archivedContacts}* contact(s) and *${archived.archivedCompanies}* company(ies).${errorNote}`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
      if (archived.errors.length > 0 && channelId) {
        const detail = archived.errors.slice(0, 5).join("\n");
        await postThread(
          client,
          channelId,
          threadTs,
          `Some archives failed:\n${detail}`,
        );
      }
    } catch (error) {
      releaseCleanupAction(pendingId);
      const message =
        error instanceof Error ? error.message : "Failed to archive records";
      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_cleanup_marketing", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeCleanup(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This cleanup preview already expired or was discarded.",
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
          "Only the person who requested this cleanup can approve or discard it (daily auto-posts can be approved by anyone).",
        );
      }
      return;
    }

    const discardText =
      result.pending.kind === "unnamed-company"
        ? `Kept unnamed company and ${result.pending.contacts.length} contact(s) — nothing archived.`
        : result.pending.contacts.length === 1 && result.pending.companies.length === 0
          ? `Kept contact *${result.pending.contacts[0].name}* — nothing archived.`
          : result.pending.companies.length === 1 && result.pending.contacts.length === 0
            ? `Kept company *${result.pending.companies[0].name}* — nothing archived.`
            : "Marketing cleanup discarded — nothing archived.";
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
