import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { App } from "@slack/bolt";
import { cleanupUnnamedCompanies } from "../integrations/hubspot.js";
import { SCHEDULED_CLEANUP_USER } from "../lib/cleanupStore.js";
import { addToNeverLog } from "../lib/neverLogStore.js";
import { postRecentMarketingCleanup } from "../lib/runMarketingCleanup.js";

const STATE_PATH =
  process.env.CLEANUP_STATE_PATH ??
  join(process.cwd(), "data", "cleanup-schedule-state.json");

type ScheduleState = {
  lastRunDate: string | null;
};

function cleanupChannel(): string | undefined {
  return (
    process.env.CLEANUP_CHANNEL?.trim() ||
    process.env.DIGEST_CHANNEL?.trim() ||
    undefined
  );
}

function lookbackMs(): number {
  const hours = Number(process.env.CLEANUP_LOOKBACK_HOURS ?? 24) || 24;
  return hours * 60 * 60 * 1000;
}

function cleanupHour(): number {
  const hour = Number(process.env.CLEANUP_HOUR ?? 8);
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : 8;
}

function cleanupTimeZone(): string {
  return process.env.CLEANUP_TZ?.trim() || "America/Los_Angeles";
}

function zonedParts(
  now: Date,
  timeZone: string,
): { date: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

async function loadState(): Promise<ScheduleState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScheduleState>;
    return {
      lastRunDate:
        typeof parsed.lastRunDate === "string" ? parsed.lastRunDate : null,
    };
  } catch {
    return { lastRunDate: null };
  }
}

async function saveState(state: ScheduleState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Auto-archive blank-name companies (and their contacts) from the lookback
 * window, then add emails/domains to Never Log so email auto-logging skips them.
 */
export async function runScheduledUnnamedCompanyCleanup(
  client: App["client"],
): Promise<{
  archivedCompanies: number;
  archivedContacts: number;
  neverLogAdded: number;
}> {
  const channel = cleanupChannel();
  const createdAfterMs = Date.now() - lookbackMs();
  const lookbackHours = Math.round(lookbackMs() / 3_600_000);

  const cleaned = await cleanupUnnamedCompanies({
    createdAfterMs,
    maxCompanies: 40,
  });

  const neverLog = await addToNeverLog({
    emails: cleaned.neverLogEmails,
    domains: cleaned.neverLogDomains,
  });

  if (cleaned.archivedCompanies === 0 && cleaned.archivedContacts === 0) {
    console.log(
      `[cleanup] Unnamed-company scan: nothing to archive (last ${lookbackHours}h).`,
    );
    return {
      archivedCompanies: 0,
      archivedContacts: 0,
      neverLogAdded: 0,
    };
  }

  const neverLogNote =
    neverLog.emails.length + neverLog.domains.length > 0
      ? `\nNever Log += ${neverLog.emails.length} email(s), ${neverLog.domains.length} domain(s).`
      : "";
  const errorNote =
    cleaned.errors.length > 0
      ? `\n_${cleaned.errors.length} error(s) — check logs._`
      : "";

  const lines = cleaned.items
    .slice(0, 15)
    .map((item) => {
      const emails =
        item.emails.length > 0 ? item.emails.join(", ") : "(no email)";
      const domain = item.domain ? ` · ${item.domain}` : "";
      return `• blank-name company${domain} → archived ${item.contactIds.length} contact(s): ${emails}`;
    })
    .join("\n");

  if (channel) {
    await client.chat.postMessage({
      channel,
      text: `Auto-archived ${cleaned.archivedCompanies} unnamed compan(ies) and ${cleaned.archivedContacts} contact(s) (last ${lookbackHours}h).`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "Unnamed company cleanup (auto)",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `Archived *${cleaned.archivedCompanies}* company(ies) with no name and *${cleaned.archivedContacts}* associated contact(s) from the last *${lookbackHours} hours* (skipped any with deals).` +
              neverLogNote +
              errorNote,
          },
        },
        ...(lines
          ? [
              {
                type: "section" as const,
                text: { type: "mrkdwn" as const, text: lines },
              },
            ]
          : []),
      ],
    });
  }

  console.log(
    `[cleanup] Unnamed companies: archived ${cleaned.archivedCompanies} companies, ${cleaned.archivedContacts} contacts; never-log +${neverLog.emails.length} emails / +${neverLog.domains.length} domains.`,
  );

  return {
    archivedCompanies: cleaned.archivedCompanies,
    archivedContacts: cleaned.archivedContacts,
    neverLogAdded: neverLog.emails.length + neverLog.domains.length,
  };
}

/**
 * Scan last N hours of new contacts/companies, classify marketing email
 * activity, and post a summary plus one Approve/Discard card per record.
 */
export async function runScheduledMarketingCleanup(
  client: App["client"],
): Promise<{ posted: boolean; contacts: number; companies: number }> {
  const channel = cleanupChannel();
  if (!channel) {
    throw new Error(
      "Missing CLEANUP_CHANNEL or DIGEST_CHANNEL — cannot post daily cleanup",
    );
  }

  const lookbackHours = Math.round(lookbackMs() / 3_600_000);
  const posted = await postRecentMarketingCleanup({
    client,
    channel,
    userId: SCHEDULED_CLEANUP_USER,
  });

  if (posted.contacts === 0 && posted.companies === 0) {
    console.log(
      `[cleanup] Daily scan: nothing to clean (last ${lookbackHours}h).`,
    );
    return { posted: false, contacts: 0, companies: 0 };
  }

  console.log(
    `[cleanup] Posted daily cleanup: ${posted.contacts} contacts, ${posted.companies} companies → #${channel}`,
  );
  return {
    posted: true,
    contacts: posted.contacts,
    companies: posted.companies,
  };
}

/** Run both daily cleanup passes (unnamed auto-archive + marketing preview). */
export async function runDailyCleanupJobs(client: App["client"]): Promise<void> {
  await runScheduledUnnamedCompanyCleanup(client);
  await runScheduledMarketingCleanup(client);
}

function shouldRunToday(
  now: Date,
  lastRunDate: string | null,
): { run: boolean; today: string } {
  const tz = cleanupTimeZone();
  const hour = cleanupHour();
  const parts = zonedParts(now, tz);
  if (lastRunDate === parts.date) {
    return { run: false, today: parts.date };
  }
  // Fire once on/after the configured hour (catch-up if bot was down at :00).
  if (parts.hour < hour) {
    return { run: false, today: parts.date };
  }
  return { run: true, today: parts.date };
}

/** Poll once a minute; run at most once per local calendar day at CLEANUP_HOUR. */
export function startMarketingCleanupScheduler(client: App["client"]): void {
  if (process.env.CLEANUP_ENABLED === "false") {
    console.log("[cleanup] Daily scheduler disabled (CLEANUP_ENABLED=false).");
    return;
  }

  const channel = cleanupChannel();
  if (!channel) {
    console.warn(
      "[cleanup] CLEANUP_CHANNEL / DIGEST_CHANNEL unset — daily cleanup skipped.",
    );
    return;
  }

  const hour = cleanupHour();
  const tz = cleanupTimeZone();
  const lookbackHours = Math.round(lookbackMs() / 3_600_000);

  const tick = async () => {
    try {
      const state = await loadState();
      const { run, today } = shouldRunToday(new Date(), state.lastRunDate);
      if (!run) {
        return;
      }
      // Mark the day before the scan so a crash mid-run doesn't double-post.
      await saveState({ lastRunDate: today });
      await runDailyCleanupJobs(client);
    } catch (error) {
      console.error("[cleanup] Daily run failed:", error);
    }
  };

  setTimeout(tick, 15_000);
  setInterval(tick, 60_000);
  console.log(
    `[cleanup] Daily cleanup scheduled for ${hour}:00 ${tz} → #${channel} (lookback ${lookbackHours}h; unnamed companies auto-archive; marketing email review with per-record Approve cards).`,
  );
}
