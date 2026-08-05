import { randomUUID } from "node:crypto";
import type {
  PendingReminder,
  TakeReminderResult,
} from "../types/pendingReminder.js";

/** Pending reminders expire after 30 minutes. */
export const REMINDER_TTL_MS = 30 * 60 * 1000;

const pendingReminders = new Map<string, PendingReminder>();
const inFlight = new Set<string>();

function isExpired(pending: PendingReminder, now = Date.now()): boolean {
  return now - pending.createdAt > REMINDER_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingReminders) {
    if (isExpired(pending, now)) {
      pendingReminders.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingReminder(
  pending: Omit<PendingReminder, "id" | "createdAt">,
): PendingReminder {
  purgeExpired();

  const record: PendingReminder = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingReminders.set(record.id, record);
  return record;
}

export function beginReminderAction(
  id: string,
  userId: string,
): TakeReminderResult {
  purgeExpired();
  const pending = pendingReminders.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingReminders.delete(id);
      inFlight.delete(id);
    }
    return { status: "not_found" };
  }

  if (pending.createdBy !== userId) {
    return { status: "forbidden" };
  }

  if (inFlight.has(id)) {
    return { status: "not_found" };
  }

  inFlight.add(id);
  return { status: "ok", pending };
}

export function completeReminderAction(id: string): void {
  pendingReminders.delete(id);
  inFlight.delete(id);
}

export function releaseReminderAction(id: string): void {
  inFlight.delete(id);
}

export function takeReminder(id: string, userId: string): TakeReminderResult {
  const result = beginReminderAction(id, userId);
  if (result.status === "ok") {
    completeReminderAction(id);
  }
  return result;
}
