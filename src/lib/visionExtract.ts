import type OpenAI from "openai";

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

const SYSTEM = `You extract sales-lead contact details from images for a CRM.
Images may be: conference/event badges, printed business cards, or screenshots of WhatsApp or LinkedIn conversations.
Return EVERY distinct person you can identify as a lead.

Rules:
- Only include a field if you can actually read it in the image. NEVER invent or guess emails, phone numbers, or companies — leave them blank instead.
- Badge / business card: read first name, last name, job title, company, email, phone, and any LinkedIn handle.
- WhatsApp / LinkedIn screenshot: the lead is the OTHER person in the conversation (not the account owner). Capture their name and, if mentioned, their company and title. Put a one-line summary of what they said (e.g. a meeting request or stated interest) in "notes".
- Put any event/source hint you can infer (text on the badge, or the user's context) in "source".

Respond ONLY with JSON of this shape:
{"leads":[{"firstName":"","lastName":"","company":"","email":"","phone":"","mobile":"","title":"","linkedin":"","source":"","notes":""}]}
Use empty strings for fields you cannot fill. If no person is present, return {"leads":[]}.`;

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
        ({ type: "image_url", image_url: { url } }) as const,
    ),
  ];

  const completion = await openai.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      { role: "system", content: SYSTEM },
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

  const optional = [
    "lastName",
    "company",
    "email",
    "phone",
    "mobile",
    "title",
    "linkedin",
    "source",
    "notes",
  ] as const;

  const leads: ExtractedLead[] = [];
  for (const item of parsed.leads) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const firstName = String(rec.firstName ?? "").trim();
    if (!firstName) {
      continue;
    }

    const lead: ExtractedLead = { firstName };
    for (const key of optional) {
      const value = rec[key];
      if (value != null && String(value).trim()) {
        lead[key] = String(value).trim();
      }
    }
    leads.push(lead);
  }

  return leads;
}
