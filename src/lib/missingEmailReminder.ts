import type { App } from "@slack/bolt";
import {
  associateTaskToRecord,
  createTask,
  getObjectProperties,
  type NoteRecordType,
} from "../integrations/hubspot.js";

export type MissingEmailTarget = {
  recordType: NoteRecordType;
  recordId: string;
  recordName: string;
};

/** Hours until the "get their email" task is due. */
function reminderHours(): number {
  const hours = Number(process.env.MISSING_EMAIL_REMINDER_HOURS ?? 24);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function enabled(): boolean {
  return process.env.MISSING_EMAIL_REMINDER !== "false";
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

function label(recordType: NoteRecordType): string {
  return recordType === "contact"
    ? "contact"
    : recordType === "company"
      ? "company"
      : "deal";
}

/** What's missing, phrased per record type. */
function missingWhat(recordType: NoteRecordType): string {
  return recordType === "company"
    ? "no domain or contact email on file"
    : recordType === "deal"
      ? "no contact with an email address"
      : "no email address on file";
}

/**
 * Create a HubSpot task + scheduled Slack nudge to go get the missing email.
 *
 * Fire-and-forget by design: a record was just created successfully, so a
 * failure here must never surface as a creation failure. Returns a sentence to
 * append to the success message, or "" when no reminder was needed or possible.
 */
export async function createMissingEmailReminder(
  client: App["client"],
  target: MissingEmailTarget,
  opts: { channelId?: string; userId: string },
): Promise<string> {
  if (!enabled() || !opts.channelId) {
    return "";
  }

  const dueMs = Date.now() + reminderHours() * 60 * 60 * 1000;
  const kind = label(target.recordType);
  const subject = `Get email address: ${target.recordName}`;

  try {
    const task = await createTask({
      subject,
      dueMs,
      body: `Auto-created — this ${kind} was added with ${missingWhat(target.recordType)}. Track down an email address so we can reach them.`,
      ...(process.env.HUBSPOT_OWNER_ID
        ? { ownerId: process.env.HUBSPOT_OWNER_ID }
        : {}),
    });
    await associateTaskToRecord(task.id, target.recordType, target.recordId);

    // Slack requires post_at in the future.
    const postAt = Math.max(
      Math.floor(dueMs / 1000),
      Math.floor(Date.now() / 1000) + 60,
    );
    await client.chat.scheduleMessage({
      channel: opts.channelId,
      post_at: postAt,
      text: `:email: Missing email — <@${opts.userId}>: the ${kind} *${target.recordName}* was created with ${missingWhat(target.recordType)}. Can you track one down?`,
    });

    return ` No email on file — reminder set (task due ${formatDue(dueMs)} + Slack nudge).`;
  } catch (error) {
    console.error("[missing-email] reminder failed:", error);
    return "";
  }
}

/** True when a contact/company/deal was created with no way to email anyone. */
export function hasNoEmail(email: string | null | undefined): boolean {
  return !email?.trim();
}

/**
 * A company counts as reachable if it has a domain. Falls back to "reachable"
 * on a lookup failure so a HubSpot hiccup can't spawn a bogus reminder.
 */
export async function companyLacksEmail(companyId: string): Promise<boolean> {
  try {
    const props = await getObjectProperties("companies", companyId, ["domain"]);
    return hasNoEmail(props.domain);
  } catch (error) {
    console.error("[missing-email] company domain lookup failed:", error);
    return false;
  }
}
