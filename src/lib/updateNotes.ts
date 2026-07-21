import {
  findNoteRecords,
  getObjectProperties,
  updateObjectProperties,
  type NoteRecordMatch,
  type NoteRecordType,
} from "../integrations/hubspot.js";
import {
  appendDatedNote,
  companyActivityDateProperty,
  companyNotesProperty,
  contactActivityDateProperty,
  contactNotesProperty,
  dealActivityDateProperty,
  dealNotesProperty,
  todayDatePropertyValue,
} from "./noteProperties.js";

const OBJECT_TYPE: Record<NoteRecordType, "contacts" | "companies" | "deals"> =
  {
    contact: "contacts",
    company: "companies",
    deal: "deals",
  };

function propertiesFor(type: NoteRecordType): {
  notes: string;
  date: string;
} {
  switch (type) {
    case "contact":
      return {
        notes: contactNotesProperty(),
        date: contactActivityDateProperty(),
      };
    case "company":
      return {
        notes: companyNotesProperty(),
        date: companyActivityDateProperty(),
      };
    case "deal":
      return {
        notes: dealNotesProperty(),
        date: dealActivityDateProperty(),
      };
  }
}

export function parseUpdateNotesText(
  text: string,
): { name: string; note: string } | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const separators = [" — ", " -- ", " - ", ": "];
  for (const sep of separators) {
    const idx = trimmed.indexOf(sep);
    if (idx > 0) {
      const name = trimmed.slice(0, idx).trim();
      const note = trimmed.slice(idx + sep.length).trim();
      if (name && note) {
        return { name, note };
      }
    }
  }

  return null;
}

export async function resolveNoteRecord(
  name: string,
): Promise<NoteRecordMatch | NoteRecordMatch[]> {
  return findNoteRecords(name);
}

export async function appendNotesToRecord(
  match: NoteRecordMatch,
  note: string,
): Promise<NoteRecordMatch> {
  const objectType = OBJECT_TYPE[match.type];
  const { notes: notesProp, date: dateProp } = propertiesFor(match.type);

  const current = await getObjectProperties(objectType, match.id, [notesProp]);
  const nextNotes = appendDatedNote(current[notesProp], note);

  await updateObjectProperties(objectType, match.id, {
    [notesProp]: nextNotes,
    [dateProp]: todayDatePropertyValue(),
  });

  return match;
}
