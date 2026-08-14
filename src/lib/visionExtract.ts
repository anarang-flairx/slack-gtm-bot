import type OpenAI from "openai";
import { parseContactName } from "../integrations/hubspot.js";

export type ExtractedLead = {
  firstName: string;
  lastName?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  linkedin?: string;
  source?: string;
  notes?: string;
};

const VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";

function buildSystemPrompt(): string {
  const owner =
    process.env.SENDER_NAME?.trim() ||
    process.env.GMAIL_SENDER_EMAIL?.trim() ||
    "the FlairX account owner";

  return `You extract sales-lead contact details from images for a CRM.
Images may be: conference/event badges, printed business cards, or screenshots of WhatsApp or LinkedIn conversations.
Return EVERY distinct person you can identify as a lead.

Rules:
- Only include a field if you can actually read it in the image. NEVER invent or guess emails, phone numbers, or companies — leave them blank instead.
- Put the given name in "firstName" and family name in "lastName". Never put a full name in firstName alone.
- Badge / business card: read first name, last name, job title, company, email, phone, and any LinkedIn URL or handle.
- WhatsApp / LinkedIn screenshot: the lead is the OTHER person in the conversation — never "${owner}" / the FlairX account owner. Capture their name and, if mentioned, their company and title. Put a one-line summary of what they said (e.g. a meeting request or stated interest) in "notes".
- Put any event/source hint you can infer (text on the badge, or the user's context) in "source".

Respond ONLY with JSON of this shape:
{"leads":[{"firstName":"","lastName":"","company":"","email":"","phone":"","mobile":"","title":"","linkedin":"","source":"","notes":""}]}
Use empty strings for fields you cannot fill. If no person is present, return {"leads":[]}.`;
}

/** Fix common OCR email noise; return undefined if it still isn't an email. */
export function normalizeOcrEmail(raw: string): string | undefined {
  let value = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\[at\]/gi, "@")
    .replace(/\(at\)/gi, "@")
    .replace(/\bat\b/gi, "@")
    .replace(/,/g, ".")
    .replace(/;+/g, "");

  // Drop trailing punctuation from OCR.
  value = value.replace(/[)>\].,;:]+$/g, "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return undefined;
  }
  return value;
}

/** Keep digits (and leading +); require enough digits to be useful. */
export function normalizeOcrPhone(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) {
    return undefined;
  }
  return `${plus}${digits}`;
}

/** Prefer a full LinkedIn URL. */
export function normalizeOcrLinkedin(raw: string): string | undefined {
  let value = raw.trim();
  if (!value) {
    return undefined;
  }
  value = value.replace(/\s+/g, "");
  if (/^@[\w.-]+$/.test(value)) {
    value = value.slice(1);
  }
  if (/^in\//i.test(value)) {
    value = `https://www.linkedin.com/${value}`;
  } else if (/^[\w.-]+$/.test(value) && !value.includes(".")) {
    value = `https://www.linkedin.com/in/${value}`;
  } else if (/^linkedin\.com\//i.test(value)) {
    value = `https://www.${value}`;
  } else if (/^www\.linkedin\.com\//i.test(value)) {
    value = `https://${value}`;
  }

  if (!/^https?:\/\/(www\.)?linkedin\.com\//i.test(value)) {
    // Keep a plausible URL the model already produced.
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    return undefined;
  }
  return value;
}

function splitNameFields(
  firstNameRaw: string,
  lastNameRaw?: string,
): { firstName: string; lastName?: string } {
  const cleaned = firstNameRaw
    .trim()
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "");
  const last = lastNameRaw?.trim() ?? "";
  if (last) {
    return {
      firstName: cleaned || firstNameRaw.trim(),
      lastName: last,
    };
  }
  // Model dumped "Jane Doe" (or "Dr. Jane Doe") into firstName only.
  const { firstName, lastName } = parseContactName(cleaned || firstNameRaw);
  return {
    firstName,
    ...(lastName ? { lastName } : {}),
  };
}

export function normalizeExtractedLead(
  raw: Record<string, unknown>,
): ExtractedLead | null {
  const firstRaw = String(raw.firstName ?? "").trim();
  if (!firstRaw) {
    return null;
  }

  const lastRaw = String(raw.lastName ?? "").trim();
  const { firstName, lastName } = splitNameFields(firstRaw, lastRaw || undefined);
  if (!firstName) {
    return null;
  }

  const lead: ExtractedLead = { firstName };
  if (lastName) {
    lead.lastName = lastName;
  }

  const company = String(raw.company ?? "").trim();
  if (company) {
    lead.company = company;
  }

  const email = normalizeOcrEmail(String(raw.email ?? ""));
  if (email) {
    lead.email = email;
  }

  const phone = normalizeOcrPhone(String(raw.phone ?? ""));
  const mobile = normalizeOcrPhone(String(raw.mobile ?? ""));
  if (phone && mobile && phone === mobile) {
    lead.phone = phone;
  } else {
    if (phone) {
      lead.phone = phone;
    }
    if (mobile) {
      lead.mobile = mobile;
    }
  }
  // Single number OCR often lands randomly in mobile — prefer phone.
  if (!lead.phone && lead.mobile) {
    lead.phone = lead.mobile;
    delete lead.mobile;
  }

  const title = String(raw.title ?? "").trim();
  if (title) {
    lead.title = title;
  }

  const linkedin = normalizeOcrLinkedin(String(raw.linkedin ?? ""));
  if (linkedin) {
    lead.linkedin = linkedin;
  }

  const source = String(raw.source ?? "").trim();
  if (source) {
    lead.source = source;
  }

  const notes = String(raw.notes ?? "").trim();
  if (notes) {
    lead.notes = notes;
  }

  return lead;
}

export async function extractLeadsFromImages(
  openai: OpenAI,
  imageDataUrls: string[],
  context: string,
): Promise<ExtractedLead[]> {
  if (imageDataUrls.length === 0) {
    return [];
  }

  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: context
        ? `User context: ${context}\nExtract the lead(s) from the image(s).`
        : "Extract the lead(s) from the image(s).",
    },
    ...imageDataUrls.map(
      (url) =>
        ({
          type: "image_url",
          image_url: { url, detail: "high" as const },
        }) as const,
    ),
  ];

  const completion = await openai.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: parts },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { leads?: unknown };
  try {
    parsed = JSON.parse(raw) as { leads?: unknown };
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.leads)) {
    return [];
  }

  const leads: ExtractedLead[] = [];
  for (const item of parsed.leads) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const lead = normalizeExtractedLead(item as Record<string, unknown>);
    if (lead) {
      leads.push(lead);
    }
  }

  return leads;
}
