import type { DealCreateSession } from "../types/dealCreateSession.js";

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, DealCreateSession>();

function isExpired(session: DealCreateSession, now = Date.now()): boolean {
  return now - session.createdAt > SESSION_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [key, session] of sessions) {
    if (isExpired(session, now)) {
      sessions.delete(key);
    }
  }
}

export function sessionKey(channelId: string, threadTs?: string): string {
  return `${channelId}:${threadTs ?? ""}`;
}

export function getDealCreateSession(
  channelId: string,
  threadTs?: string,
): DealCreateSession | undefined {
  purgeExpired();
  const key = sessionKey(channelId, threadTs);
  const session = sessions.get(key);
  if (!session || isExpired(session)) {
    sessions.delete(key);
    return undefined;
  }
  return session;
}

export function saveDealCreateSession(
  session: Omit<DealCreateSession, "createdAt">,
): DealCreateSession {
  purgeExpired();
  const record: DealCreateSession = {
    ...session,
    createdAt: Date.now(),
  };
  sessions.set(record.key, record);
  return record;
}

export function clearDealCreateSession(
  channelId: string,
  threadTs?: string,
): void {
  sessions.delete(sessionKey(channelId, threadTs));
}
