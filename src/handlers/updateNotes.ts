import type { KnownBlock } from "@slack/types";
import type { App } from "@slack/bolt";
import { hubspotRecordUrl } from "../digest/format.js";
import type { NoteRecordMatch } from "../integrations/hubspot.js";
import { appendDatedNote } from "../lib/noteProperties.js";
import { savePendingNoteUpdate } from "../lib/noteUpdateStore.js";
import {
  parseUpdateNotesText,
  resolveNoteRecord,
} from "../lib/updateNotes.js";
import { postPublic } from "../lib/slackPost.js";

function formatMatchLine(match: NoteRecordMatch, index: number): string {
  return `${index + 1}. [${match.type}] ${match.name} — ${match.detail}`;
}

function truncate(text: string, max = 2800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n...(truncated in preview)`;
}

function buildPreviewBlocks(
  match: NoteRecordMatch,
  note: string,
  pendingId: string,
): KnownBlock[] {
  const url = hubspotRecordUrl(match.type, match.id);
  const previewLine = appendDatedNote("", note);

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Update notes preview",
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Record:*\n<${url}|${match.name}>`,
        },
        {
          type: "mrkdwn",
          text: `*Type:*\n${match.type}`,
        },
        {
          type: "mrkdwn",
          text: `*Detail:*\n${match.detail || "—"}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Note to append:*\n\`\`\`${truncate(previewLine)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve → HubSpot" },
          style: "primary",
          action_id: "approve_notes_update",
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Discard" },
          style: "danger",
          action_id: "discard_notes_update",
          value: pendingId,
        },
      ],
    },
  ];
}

export function registerUpdateNotesCommand(app: App): void {
  app.command("/update-notes", async ({ command, ack, client }) => {
    await ack();

    const parsed = parseUpdateNotesText(command.text);
    if (!parsed) {
      await postPublic(
        client,
        command.channel_id,
        "Usage: `/update-notes Jane Doe — called; demo next week` (use `—`, `-`, or `:` between name and note)",
      );
      return;
    }

    try {
      const result = await resolveNoteRecord(parsed.name);

      if (Array.isArray(result)) {
        const options = result.map(formatMatchLine).join("\n");
        await postPublic(
          client,
          command.channel_id,
          `Multiple records matched "${parsed.name}". Be more specific:\n${options}`,
        );
        return;
      }

      const pending = savePendingNoteUpdate({
        recordType: result.type,
        recordId: result.id,
        recordName: result.name,
        recordDetail: result.detail,
        note: parsed.note,
        createdBy: command.user_id,
        channelId: command.channel_id,
      });

      await postPublic(
        client,
        command.channel_id,
        `Notes update ready for ${result.name}`,
        buildPreviewBlocks(result, parsed.note, pending.id),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to prepare notes update";

      await postPublic(client, command.channel_id, message);
    }
  });
}
