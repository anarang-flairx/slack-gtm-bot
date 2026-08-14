import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATE_PATH =
  process.env.NEVER_LOG_PATH ?? join(process.cwd(), "data", "never-log.json");

export type NeverLogState = {
  emails: string[];
  domains: string[];
  updatedAt: string | null;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^www\./, "");
}

async function loadState(): Promise<NeverLogState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<NeverLogState>;
    return {
      emails: Array.isArray(parsed.emails)
        ? parsed.emails.map(normalizeEmail).filter(Boolean)
        : [],
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.map(normalizeDomain).filter(Boolean)
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { emails: [], domains: [], updatedAt: null };
  }
}

async function saveState(state: NeverLogState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        emails: [...new Set(state.emails)].sort(),
        domains: [...new Set(state.domains)].sort(),
        updatedAt: state.updatedAt,
      },
      null,
      2,
    ),
  );
}

/** Add emails/domains so the email auto-logger never writes notes for them. */
export async function addToNeverLog(input: {
  emails?: string[];
  domains?: string[];
}): Promise<{ emails: string[]; domains: string[] }> {
  const state = await loadState();
  const addedEmails: string[] = [];
  const addedDomains: string[] = [];

  for (const email of input.emails ?? []) {
    const normalized = normalizeEmail(email);
    if (!normalized || !normalized.includes("@")) {
      continue;
    }
    if (!state.emails.includes(normalized)) {
      state.emails.push(normalized);
      addedEmails.push(normalized);
    }
  }

  for (const domain of input.domains ?? []) {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      continue;
    }
    if (!state.domains.includes(normalized)) {
      state.domains.push(normalized);
      addedDomains.push(normalized);
    }
  }

  if (addedEmails.length > 0 || addedDomains.length > 0) {
    state.updatedAt = new Date().toISOString();
    await saveState(state);
  }

  return { emails: addedEmails, domains: addedDomains };
}

export async function isNeverLogEmail(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }
  const state = await loadState();
  if (state.emails.includes(normalized)) {
    return true;
  }
  const domain = normalizeDomain(normalized.split("@")[1] ?? "");
  return Boolean(domain && state.domains.includes(domain));
}

export async function isNeverLogDomain(domain: string): Promise<boolean> {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }
  const state = await loadState();
  return state.domains.includes(normalized);
}
