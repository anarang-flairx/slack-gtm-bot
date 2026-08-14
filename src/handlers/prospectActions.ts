import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { hubspotRecordUrl } from "../digest/format.js";
import { createContact, createProspect } from "../integrations/hubspot.js";
import {
  companyLacksEmail,
  createMissingEmailReminder,
  hasNoEmail,
} from "../lib/missingEmailReminder.js";
import {
  beginProspectAction,
  completeProspectAction,
  releaseProspectAction,
  takeProspect,
} from "../lib/prospectStore.js";
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

/**
 * Companies created alongside a contact are made with a name only, so a brand
 * new one never has a domain. Reused companies are left alone — they were not
 * created here, and may already have one.
 */
async function maybeCompanyReminder(
  client: App["client"],
  created: {
    companyId: string | null;
    companyName: string | null;
    companyCreated: boolean;
  },
  opts: { channelId?: string; userId: string },
): Promise<string> {
  if (!created.companyCreated || !created.companyId) {
    return "";
  }
  if (!(await companyLacksEmail(created.companyId))) {
    return "";
  }
  return createMissingEmailReminder(
    client,
    {
      recordType: "company",
      recordId: created.companyId,
      recordName: created.companyName ?? "new company",
    },
    opts,
  );
}

export function registerProspectActions(app: App): void {
  app.action("approve_add_prospect", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const pendingId = action.value;
    const result = beginProspectAction(pendingId, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This prospect preview expired. Mention me again to add the prospect.",
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
          "Only the person who created this prospect can approve or discard it.",
        );
      }
      return;
    }

    const pending = result.pending;

    try {
      const input = {
        firstName: pending.firstName,
        lastName: pending.lastName,
        ...(pending.companyName ? { companyName: pending.companyName } : {}),
        ...pending.fields,
      };

      const noEmail = hasNoEmail(pending.fields.email);

      if (pending.createDeal) {
        const created = await createProspect(input);
        completeProspectAction(pendingId);

        const contactUrl = hubspotRecordUrl("contact", created.contactId);
        const dealUrl = hubspotRecordUrl("deal", created.dealId);
        const companyPart = created.companyId
          ? ` · company <${hubspotRecordUrl("company", created.companyId)}|${created.companyName}>`
          : "";

        // No email means neither the contact nor its new deal is reachable.
        const reminderNote = noEmail
          ? await createMissingEmailReminder(
              client,
              {
                recordType: "contact",
                recordId: created.contactId,
                recordName: created.contactName,
              },
              { channelId, userId },
            )
          : "";
        const companyReminderNote = await maybeCompanyReminder(
          client,
          created,
          { channelId, userId },
        );

        const successText = `Prospect created: contact <${contactUrl}|${created.contactName}> · deal <${dealUrl}|${created.dealName}> (${created.stageLabel})${companyPart}${reminderNote}${companyReminderNote}`;
        await replaceMessage(client, channelId, messageTs, successText);

        if (channelId && !messageTs) {
          await postThread(client, channelId, threadTs, successText);
        }
        return;
      }

      const created = await createContact(input);
      completeProspectAction(pendingId);

      const contactUrl = hubspotRecordUrl("contact", created.contactId);
      const companyPart = created.companyId
        ? ` · company <${hubspotRecordUrl("company", created.companyId)}|${created.companyName}>`
        : "";

      const reminderNote = noEmail
        ? await createMissingEmailReminder(
            client,
            {
              recordType: "contact",
              recordId: created.contactId,
              recordName: created.contactName,
            },
            { channelId, userId },
          )
        : "";
      const companyReminderNote = await maybeCompanyReminder(client, created, {
        channelId,
        userId,
      });

      const successText = `Contact added: <${contactUrl}|${created.contactName}>${companyPart}${reminderNote}${companyReminderNote}`;
      await replaceMessage(client, channelId, messageTs, successText);

      if (channelId && !messageTs) {
        await postThread(client, channelId, threadTs, successText);
      }
    } catch (error) {
      releaseProspectAction(pendingId);

      const message =
        error instanceof Error ? error.message : "Failed to create prospect";

      if (channelId) {
        await postThread(client, channelId, threadTs, message);
      }
    }
  });

  app.action("discard_add_prospect", async ({ ack, body, action, client }) => {
    await ack();

    if (action.type !== "button" || !action.value) {
      return;
    }

    const { channelId, messageTs, threadTs, userId } = actionContext(body);
    const result = takeProspect(action.value, userId);

    if (result.status === "not_found") {
      if (channelId) {
        await postThread(
          client,
          channelId,
          threadTs,
          "This prospect preview already expired or was discarded.",
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
          "Only the person who created this prospect can approve or discard it.",
        );
      }
      return;
    }

    const discardText = `Prospect for *${result.pending.displayName}* discarded.`;
    await replaceMessage(client, channelId, messageTs, discardText);

    if (channelId && !messageTs) {
      await postThread(client, channelId, threadTs, discardText);
    }
  });
}
