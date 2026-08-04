import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { App } from "@slack/bolt";
import type OpenAI from "openai";
import {
  getSentEmail,
  listSentMessageIds,
  type SentEmail,
} from "../integrations/gmail.js";
import {
  findCompanyByDomain,
  findContactByEmail,
  getAssociatedCompany,
} from "../integrations/hubspot.js";
import { appendNotesToRecord } from "../lib/updateNotes.js";

const STATE_PATH =
  process.env.EMAIL_LOG_STATE_PATH ?? ".data/email-log-state.json";
const MAX_TRACKED_IDS = 2000;

type State = { initialized: boolean; processed: string[] };

async function loadState(): Promise<State> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      initialized: parsed.initialized === true,
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
    };
  } catch {
    return { initialized: false, processed: [] };
  }
}

async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(
    STATE_PATH,
    JSON.stringify(
      {
        initialized: state.initialized,
        processed: state.processed.slice(-MAX_TRACKED_IDS),
      },
      null,
      2,
    ),
  );
}

async function summarizeEmail(
  openai: OpenAI,
  subject: string,
  body: string,
): Promise<string> {
  const model = process.env.OPENAI_CHEAP_MODEL ?? "gpt-4.1-mini";
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Summarize this outbound sales email in 1-2 concise sentences for a CRM activity note. Focus on what was communicated or offered and any next step. No preamble, no greeting.",
      },
      {
        role: "user",
        content: `Subject: ${subject}\n\n${body.slice(0, 6000)}`,
      },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() || subject;
}

async function processSentEmail(
  openai: OpenAI,
  client: App["client"],
  email: SentEmail,
  channel: string | undefined,
): Promise<void> {
  if (email.recipients.length === 0) {
    return;
  }

  const contacts = new Map<string, { id: string; name: string }>();
  const companies = new Map<string, { id: string; name: string }>();

  for (const address of email.recipients) {
    const contact = await findContactByEmail(address);
    if (contact) {
      contacts.set(contact.id, contact);
      const company = await getAssociatedCompany(contact.id);
      if (company) {
        companies.set(company.id, company);
      }
      continue;
    }
    // No contact on file: fall back to matching the company by email domain.
    const domain = address.split("@")[1] ?? "";
    if (domain) {
      const company = await findCompanyByDomain(domain);
      if (company) {
        companies.set(company.id, company);
      }
    }
  }

  if (contacts.size === 0 && companies.size === 0) {
    return; // nothing in HubSpot to attach to
  }

  const summary = await summarizeEmail(openai, email.subject, email.bodyText);
  const note = `Email sent — ${email.subject}: ${summary}`;

  for (const contact of contacts.values()) {
    await appendNotesToRecord(
      { type: "contact", id: contact.id, name: contact.name, detail: "" },
      note,
    );
  }
  for (const company of companies.values()) {
    await appendNotesToRecord(
      { type: "company", id: company.id, name: company.name, detail: "" },
      note,
    );
  }

  if (channel) {
    const targets = [
      ...[...contacts.values()].map((c) => c.name),
      ...[...companies.values()].map((c) => `${c.name} (company)`),
    ].join(", ");
    await client.chat.postMessage({
      channel,
      text: `:memo: Logged a sent email to HubSpot notes for ${targets}.\n*${email.subject}* — ${summary}`,
    });
  }
}

/**
 * Poll recent sent Gmail messages and auto-append a summary of each new one to
 * the matching HubSpot contact(s) and company(ies). On the very first run it
 * establishes a baseline (marks existing sent mail processed) so historical
 * email isn't back-filled.
 */
export async function runEmailNoteSync(
  openai: OpenAI,
  client: App["client"],
): Promise<void> {
  const lookback = Number(process.env.EMAIL_LOG_LOOKBACK_DAYS ?? 1) || 1;
  const state = await loadState();
  const processed = new Set(state.processed);

  const ids = await listSentMessageIds(lookback, 50);

  if (!state.initialized) {
    for (const { id } of ids) {
      processed.add(id);
    }
    await saveState({ initialized: true, processed: [...processed] });
    return;
  }

  const channel =
    process.env.EMAIL_LOG_CHANNEL ?? process.env.DIGEST_CHANNEL ?? undefined;

  for (const { id } of ids) {
    if (processed.has(id)) {
      continue;
    }
    try {
      const email = await getSentEmail(id);
      await processSentEmail(openai, client, email, channel);
    } catch (error) {
      console.error(`[email-log] failed to process ${id}:`, error);
    } finally {
      processed.add(id);
    }
  }

  await saveState({ initialized: true, processed: [...processed] });
}
