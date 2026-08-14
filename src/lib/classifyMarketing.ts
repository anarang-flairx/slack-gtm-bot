import OpenAI from "openai";
import type { RecentCrmRecord } from "../integrations/hubspot.js";

export type MarketingClassification = {
  marketing: boolean;
  reason: string;
  summary: string;
};

const MARKETING_HINTS = [
  "unsubscribe",
  "view in browser",
  "newsletter",
  "no-reply",
  "noreply",
  "donotreply",
  "do not reply",
  "this is an advertisement",
  "you received this email because",
  "cold outreach",
  "limited time",
  "4x arr",
  "book a demo",
  "scale your pipeline",
  "out of office",
];

function activityText(record: RecentCrmRecord): string {
  return record.snippets
    .map((s) => `${s.title}\n${s.body}`)
    .join("\n\n")
    .slice(0, 4000);
}

function heuristicClassify(record: RecentCrmRecord): MarketingClassification | null {
  const blob = `${record.email} ${record.sourceLabel} ${activityText(record)}`.toLowerCase();
  const local = record.email.split("@")[0]?.toLowerCase() ?? "";
  const source = record.sourceLabel.toLowerCase();

  if (
    local === "noreply" ||
    local.startsWith("noreply") ||
    local.includes("newsletter") ||
    local.includes("marketing")
  ) {
    return {
      marketing: true,
      reason: "marketing-style email address",
      summary: `${record.name} looks like an automated/marketing sender (${record.email || "no email"}).`,
    };
  }

  if (
    source.includes("conversation") ||
    source.includes("email_integration")
  ) {
    if (record.snippets.every((s) => s.kind === "source") && record.objectType === "contacts") {
      return {
        marketing: true,
        reason: "Conversations/email auto-create · 0 deals",
        summary: `${record.name} was auto-created from HubSpot Conversations/email logging, with no deals and no real activity.`,
      };
    }
  }

  const hits = MARKETING_HINTS.filter((h) => blob.includes(h));
  if (hits.length >= 2) {
    return {
      marketing: true,
      reason: `marketing copy (${hits.slice(0, 3).join(", ")})`,
      summary: `Logged activity for ${record.name} reads like a marketing/cold-outreach email.`,
    };
  }

  return null;
}

async function classifyWithModel(
  openai: OpenAI,
  records: RecentCrmRecord[],
): Promise<Map<string, MarketingClassification>> {
  const out = new Map<string, MarketingClassification>();
  if (records.length === 0) {
    return out;
  }

  const payload = records.map((record) => ({
    id: `${record.objectType}:${record.id}`,
    type: record.objectType,
    name: record.name,
    email: record.email,
    company: record.companyName,
    source: record.sourceLabel,
    activity: activityText(record) || "(no logged emails or notes)",
  }));

  const model = process.env.OPENAI_CHEAP_MODEL ?? "gpt-4.1-mini";
  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Classify HubSpot records created in the last day. marketing=true only for inbound marketing, newsletters, automated senders, or cold-outreach spam that should be archived. marketing=false for real people, recruiting/sales conversations with FlairX, or anything that looks like a genuine lead. Reply JSON: {"results":[{"id":"contacts:123","marketing":true,"reason":"...","summary":"1-2 sentence activity summary"}]}',
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? "{}";
  let parsed: {
    results?: Array<{
      id?: string;
      marketing?: boolean;
      reason?: string;
      summary?: string;
    }>;
  } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return out;
  }

  for (const row of parsed.results ?? []) {
    if (!row.id) {
      continue;
    }
    out.set(row.id, {
      marketing: row.marketing === true,
      reason: row.reason?.trim() || "activity review",
      summary: row.summary?.trim() || "",
    });
  }
  return out;
}

export async function classifyRecentMarketing(
  records: RecentCrmRecord[],
): Promise<Map<string, MarketingClassification>> {
  const decided = new Map<string, MarketingClassification>();
  const needsModel: RecentCrmRecord[] = [];

  for (const record of records) {
    const key = `${record.objectType}:${record.id}`;
    const heuristic = heuristicClassify(record);
    if (heuristic?.marketing) {
      decided.set(key, heuristic);
      continue;
    }
    if (record.snippets.length === 0) {
      continue;
    }
    needsModel.push(record);
  }

  if (needsModel.length === 0 || !process.env.OPENAI_API_KEY) {
    return decided;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  for (let i = 0; i < needsModel.length; i += 12) {
    const chunk = needsModel.slice(i, i + 12);
    try {
      const classified = await classifyWithModel(openai, chunk);
      for (const [key, value] of classified) {
        if (value.marketing) {
          decided.set(key, value);
        }
      }
    } catch (error) {
      console.warn("[cleanup] activity classification failed:", error);
    }
  }

  return decided;
}

export function activitySnippet(record: RecentCrmRecord): string {
  const email = record.snippets.find((s) => s.kind === "email");
  const note = record.snippets.find((s) => s.kind === "note");
  const snippet = email ?? note;
  if (!snippet) {
    return record.sourceLabel ? `Source: ${record.sourceLabel}` : "No logged activity.";
  }
  const body = snippet.body.replace(/\s+/g, " ").trim();
  const clipped = body.length > 280 ? `${body.slice(0, 277)}…` : body;
  return `${snippet.title}${clipped ? ` — ${clipped}` : ""}`;
}
