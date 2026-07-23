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

const FIELD_ALIASES: Record<string, keyof ProspectFields | "company"> = {
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
  company: "company",
  co: "company",
  org: "company",
};

const FIELD_KEY_PATTERN =
  /\b(email|e|phone|tel|mobile|title|jobtitle|job|source|lead_source|event|notes|note|linkedin|li|company|co|org)\s*=/gi;

/**
 * Slack rewrites `@google` / `@ google` in slash commands into mention tokens
 * like `<@U123|google>`, whose inner `|` breaks naive parsing. Decode those
 * back to plain text before we split identity vs fields.
 */
export function normalizeSlackCommandText(text: string): string {
  return text
    .replace(
      /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/gi,
      (_m, _id: string, label?: string) =>
        label?.trim() ? `@ ${label.trim()}` : "",
    )
    .replace(
      /<!subteam\^[A-Z0-9]+\|@?([^>]+)>/gi,
      (_m, label: string) => `@ ${label.trim()}`,
    )
    .replace(/<!([^|>]+)(?:\|([^>]+))?>/g, (_m, _t: string, label?: string) =>
      label?.trim() ? label.trim() : "",
    )
    .replace(
      /<mailto:([^|>]+)(?:\|([^>]+))?>/gi,
      (_m, email: string, label?: string) => label?.trim() || email.trim(),
    )
    .replace(
      /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/gi,
      (_m, url: string, label?: string) => label?.trim() || url.trim(),
    )
    .replace(/\s+/g, " ")
    .trim();
}

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

function splitIdentityAndFields(raw: string): {
  identityPart: string;
  fieldPart: string;
} {
  // Prefer ` | ` so pipes inside decoded text are less ambiguous.
  const spaced = raw.search(/\s\|\s/);
  if (spaced >= 0) {
    return {
      identityPart: raw.slice(0, spaced).trim(),
      fieldPart: raw.slice(spaced + 1).replace(/^\|/, "").trim(),
    };
  }

  // Else: first `|` that starts a known field key.
  FIELD_KEY_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIELD_KEY_PATTERN.exec(raw)) !== null) {
    const before = raw.slice(0, match.index);
    const pipeIdx = before.lastIndexOf("|");
    if (pipeIdx >= 0) {
      return {
        identityPart: raw.slice(0, pipeIdx).trim(),
        fieldPart: raw.slice(pipeIdx + 1).trim(),
      };
    }
  }

  return { identityPart: raw.trim(), fieldPart: "" };
}

function parseFieldSegment(segment: string): {
  fields: ProspectFields;
  companyName?: string;
  unknownKeys: string[];
} {
  const fields: ProspectFields = {};
  const unknownKeys: string[] = [];
  let companyName: string | undefined;
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
      i + 1 < matches.length
        ? (matches[i + 1].index ?? segment.length)
        : segment.length;
    const value = stripQuotes(segment.slice(valueStart, valueEnd));

    if (!canonical) {
      unknownKeys.push(rawKey);
      continue;
    }

    if (!value) {
      continue;
    }

    if (canonical === "company") {
      companyName = value;
    } else {
      fields[canonical] = value;
    }
  }

  return { fields, ...(companyName ? { companyName } : {}), unknownKeys };
}

function splitPersonAndCompany(identityPart: string): {
  personPart: string;
  companyName?: string;
} {
  // `Jane Doe @ Acme` or `Jane Doe @Acme` (Slack often drops the space after @)
  const atMatch = identityPart.match(/^(.+?)\s+@\s*(.+)$/i);
  if (atMatch) {
    return {
      personPart: atMatch[1].trim(),
      companyName: atMatch[2].trim() || undefined,
    };
  }

  const atWordMatch = identityPart.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atWordMatch) {
    return {
      personPart: atWordMatch[1].trim(),
      companyName: atWordMatch[2].trim() || undefined,
    };
  }

  const commaMatch = identityPart.match(/^(.+?),\s*(.+)$/);
  if (commaMatch) {
    return {
      personPart: commaMatch[1].trim(),
      companyName: commaMatch[2].trim() || undefined,
    };
  }

  return { personPart: identityPart };
}

/**
 * Parse `/add-prospect` text.
 *
 * Examples:
 * - Jane Doe
 * - Jane Doe @ Acme
 * - Jane Doe @Acme
 * - Jane Doe @ Acme | email=jane@acme.com phone=555-1234
 * - Jane Doe | company=Acme email=jane@x.com title="VP Talent"
 */
export function parseProspectText(text: string): ParsedProspect | null {
  const raw = normalizeSlackCommandText(text);
  if (!raw) {
    return null;
  }

  const { identityPart, fieldPart } = splitIdentityAndFields(raw);
  if (!identityPart) {
    return null;
  }

  let { personPart, companyName } = splitPersonAndCompany(identityPart);
  if (!personPart) {
    return null;
  }

  const parsedFields = fieldPart
    ? parseFieldSegment(fieldPart)
    : { fields: {} as ProspectFields, unknownKeys: [] as string[] };

  if (parsedFields.unknownKeys.length > 0) {
    throw new Error(
      `Unrecognized prospect fields: ${parsedFields.unknownKeys.join(", ")}. Use email, phone, mobile, title, source, notes, linkedin, company (key=value after |).`,
    );
  }

  if (parsedFields.companyName) {
    companyName = parsedFields.companyName;
  }

  const { firstName, lastName } = parseContactName(personPart);
  const displayName = `${firstName} ${lastName}`.trim();

  return {
    firstName,
    lastName,
    ...(companyName ? { companyName } : {}),
    displayName,
    fields: parsedFields.fields,
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
  "Usage: `/add-prospect Jane Doe @ Acme | email=jane@acme.com phone=555-0100`\n" +
  "Tip: Slack may autocomplete `@Acme` as a mention — prefer `at Acme` or `| company=Acme`.\n" +
  "Supported fields after `|`: email, phone, mobile, title, source, notes, linkedin, company";
