import { parseContactName } from "../integrations/hubspot.js";

export type ProspectFields = {
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  source?: string;
  notes?: string;
  linkedin?: string;
};

export type ParsedProspect = {
  firstName: string;
  lastName: string;
  companyName?: string;
  displayName: string;
  fields: ProspectFields;
};

const FIELD_ALIASES: Record<string, keyof ProspectFields> = {
  email: "email",
  e: "email",
  phone: "phone",
  tel: "phone",
  mobile: "mobile",
  title: "title",
  jobtitle: "title",
  job: "title",
  source: "source",
  lead_source: "source",
  event: "source",
  notes: "notes",
  note: "notes",
  linkedin: "linkedin",
  li: "linkedin",
};

const FIELD_KEY_PATTERN =
  /\b(email|e|phone|tel|mobile|title|jobtitle|job|source|lead_source|event|notes|note|linkedin|li)\s*=/gi;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFieldSegment(segment: string): {
  fields: ProspectFields;
  unknownKeys: string[];
} {
  const fields: ProspectFields = {};
  const unknownKeys: string[] = [];
  const matches = [...segment.matchAll(FIELD_KEY_PATTERN)];

  if (matches.length === 0) {
    const leftover = segment.trim();
    if (leftover) {
      unknownKeys.push(leftover);
    }
    return { fields, unknownKeys };
  }

  const before = segment.slice(0, matches[0].index).trim();
  if (before) {
    unknownKeys.push(before);
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const rawKey = match[1].toLowerCase();
    const canonical = FIELD_ALIASES[rawKey];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd =
      i + 1 < matches.length ? (matches[i + 1].index ?? segment.length) : segment.length;
    const value = stripQuotes(segment.slice(valueStart, valueEnd));

    if (!canonical) {
      unknownKeys.push(rawKey);
      continue;
    }

    if (value) {
      fields[canonical] = value;
    }
  }

  return { fields, unknownKeys };
}

/**
 * Parse `/add-prospect` text.
 *
 * Examples:
 * - Jane Doe
 * - Jane Doe @ Acme
 * - Jane Doe @ Acme | email=jane@acme.com phone=555-1234
 * - Jane Doe | email=jane@x.com title="VP Talent" source="SHRM 2026"
 */
export function parseProspectText(text: string): ParsedProspect | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }

  const pipeIndex = raw.indexOf("|");
  const identityPart = (pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw).trim();
  const fieldPart = pipeIndex >= 0 ? raw.slice(pipeIndex + 1).trim() : "";

  if (!identityPart) {
    return null;
  }

  let personPart = identityPart;
  let companyName: string | undefined;

  const atMatch = identityPart.match(/^(.+?)\s+@\s+(.+)$/i);
  const atWordMatch = identityPart.match(/^(.+?)\s+at\s+(.+)$/i);
  const commaMatch = identityPart.match(/^(.+?),\s*(.+)$/);

  if (atMatch) {
    personPart = atMatch[1].trim();
    companyName = atMatch[2].trim();
  } else if (atWordMatch) {
    personPart = atWordMatch[1].trim();
    companyName = atWordMatch[2].trim();
  } else if (commaMatch) {
    personPart = commaMatch[1].trim();
    companyName = commaMatch[2].trim();
  }

  if (!personPart) {
    return null;
  }

  const { fields, unknownKeys } = fieldPart
    ? parseFieldSegment(fieldPart)
    : { fields: {}, unknownKeys: [] };

  if (unknownKeys.length > 0) {
    throw new Error(
      `Unrecognized prospect fields: ${unknownKeys.join(", ")}. Use email, phone, mobile, title, source, notes, linkedin (key=value after |).`,
    );
  }

  const { firstName, lastName } = parseContactName(personPart);
  const displayName = `${firstName} ${lastName}`.trim();

  return {
    firstName,
    lastName,
    ...(companyName ? { companyName } : {}),
    displayName,
    fields,
  };
}

export function formatProspectFields(fields: ProspectFields): string {
  const lines: string[] = [];
  if (fields.email) lines.push(`*Email:* ${fields.email}`);
  if (fields.phone) lines.push(`*Phone:* ${fields.phone}`);
  if (fields.mobile) lines.push(`*Mobile:* ${fields.mobile}`);
  if (fields.title) lines.push(`*Title:* ${fields.title}`);
  if (fields.source) lines.push(`*Lead source:* ${fields.source}`);
  if (fields.linkedin) lines.push(`*LinkedIn:* ${fields.linkedin}`);
  if (fields.notes) lines.push(`*Notes:* ${fields.notes}`);
  return lines.length > 0 ? lines.join("\n") : "_No extra fields_";
}

export const PROSPECT_USAGE =
  "Usage: `/add-prospect Jane Doe @ Acme | email=jane@acme.com phone=555-0100 title=\"VP Talent\" source=\"SHRM 2026\"`\nSupported fields after `|`: email, phone, mobile, title, source, notes, linkedin";
