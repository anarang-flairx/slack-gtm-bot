/** HubSpot custom note/date property internal names (overridable via env). */

export function dealNotesProperty(): string {
  return process.env.HUBSPOT_DEAL_NOTES_PROPERTY ?? "deal_notes";
}

export function dealActivityDateProperty(): string {
  return process.env.HUBSPOT_DEAL_ACTIVITY_DATE_PROPERTY ?? "notes_last_updated";
}

export function contactNotesProperty(): string {
  return process.env.HUBSPOT_CONTACT_NOTES_PROPERTY ?? "outreach_notes";
}

export function contactActivityDateProperty(): string {
  return process.env.HUBSPOT_CONTACT_ACTIVITY_DATE_PROPERTY ?? "last_contact_date";
}

export function companyNotesProperty(): string {
  return process.env.HUBSPOT_COMPANY_NOTES_PROPERTY ?? "company_notes";
}

export function companyActivityDateProperty(): string {
  return process.env.HUBSPOT_COMPANY_ACTIVITY_DATE_PROPERTY ?? "notes_last_updated";
}

/** Append a dated line to an existing notes field (PT date stamp). */
export function appendDatedNote(
  existing: string | null | undefined,
  note: string,
  now = new Date(),
): string {
  const stamp = now.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const line = `[${stamp}] ${note.trim()}`;
  const prev = existing?.trim() ?? "";
  return prev ? `${prev}\n${line}` : line;
}

/** Today's date as YYYY-MM-DD in America/Los_Angeles (HubSpot date properties). */
export function todayDatePropertyValue(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
