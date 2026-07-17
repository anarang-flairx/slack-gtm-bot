import type { App } from "@slack/bolt";
import { hubspotRecordUrl } from "../digest/format.js";
import type { NoteRecordMatch } from "../integrations/hubspot.js";
import {
  parseUpdateNotesText,
  resolveAndAppendNotes,
} from "../lib/updateNotes.js";

function formatMatchLine(match: NoteRecordMatch, index: number): string {
  return `${index + 1}. [${match.type}] ${match.name} — ${match.detail}`;
}

function successText(match: NoteRecordMatch): string {
  const url = hubspotRecordUrl(match.type, match.id);
  return `Notes updated on ${match.type} <${url}|${match.name}>.`;
}

export function registerUpdateNotesCommand(app: App): void {
  app.command("/update-notes", async ({ command, ack, client }) => {
    await ack();

    const parsed = parseUpdateNotesText(command.text);
    if (!parsed) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/update-notes Jane Doe — called; demo next week` (use `—`, `-`, or `:` between name and note)",
      });
      return;
    }

    try {
      const result = await resolveAndAppendNotes(parsed.name, parsed.note);

      if (Array.isArray(result)) {
        const options = result.map(formatMatchLine).join("\n");
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `Multiple records matched "${parsed.name}". Be more specific:\n${options}`,
        });
        return;
      }

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: successText(result),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update notes";

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: message,
      });
    }
  });
}
