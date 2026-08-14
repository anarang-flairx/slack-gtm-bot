import OpenAI from "openai";
import {
  getDealFollowUpBundle,
  getDealStageLabels,
  getObjectProperties,
} from "../integrations/hubspot.js";
import { saveDraft } from "./draftStore.js";
import type { PendingDraft } from "../types/draft.js";

export type DealFollowUpDraftPreview = {
  draft: PendingDraft;
  to: string;
  subject: string;
  body: string;
  contactName: string;
  dealName: string;
};

function senderName(): string {
  return process.env.SENDER_NAME?.trim() || "Abhilasha Juneja";
}

function parseDraftJson(raw: string): { subject: string; body: string } {
  const parsed = JSON.parse(raw) as {
    subject?: string;
    body?: string;
  };
  const subject = parsed.subject?.trim() ?? "";
  const body = parsed.body?.trim() ?? "";
  if (!subject || !body) {
    throw new Error("Model returned an empty email");
  }
  return { subject, body };
}

/**
 * Write a short follow-up from HubSpot notes/emails for this deal.
 * Posts nothing — caller saves the Gmail draft behind Approve/Discard.
 */
export async function createDealFollowUpDraft(
  dealId: string,
  userId: string,
  channelId: string,
  threadTs?: string,
): Promise<DealFollowUpDraftPreview> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to draft a personalized follow-up");
  }

  const [bundle, props, stageLabels] = await Promise.all([
    getDealFollowUpBundle(dealId),
    getObjectProperties("deals", dealId, ["dealname", "dealstage"]),
    getDealStageLabels(),
  ]);

  const contact = bundle.contacts.find((c) => c.email);
  if (!contact?.email) {
    throw new Error("No associated contact with an email on this deal");
  }

  const dealName = props.dealname?.trim() || "Untitled deal";
  const stageId = props.dealstage?.trim() ?? "";
  const stageLabel = stageLabels.get(stageId) || stageId || "—";
  const firstName = contact.name.split(/\s+/)[0] || contact.name;
  const notes = [
    ...bundle.notes.map((n) => n.body).filter(Boolean),
    bundle.dealNotes,
    bundle.company?.notes ?? "",
  ]
    .join("\n")
    .slice(0, 2500);
  const emails = bundle.emails
    .slice(0, 3)
    .map((email) => {
      const dir = email.direction || "email";
      return `${dir}: ${email.subject || "(no subject)"}\n${email.body.slice(0, 600)}`;
    })
    .join("\n\n")
    .slice(0, 2500);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1";
  const completion = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You write short follow-up emails for FlairX (AI interview platform). The sender is ${senderName()}, Founder & CEO. Voice: warm, specific, 1-2 short paragraphs. Reference the actual last interaction from the notes/emails. Ask for one clear next step. Do not invent meetings, dates, or facts. Sign as ${senderName()}. Reply JSON: {"subject":"...","body":"..."} with markdown body.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          to_name: contact.name,
          first_name: firstName,
          to_email: contact.email,
          company: bundle.company?.name ?? "",
          deal: dealName,
          stage: stageLabel,
          notes: notes || "(none)",
          emails: emails || "(none)",
        }),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const { subject, body } = parseDraftJson(raw);

  const draft = saveDraft({
    type: "event-follow-up",
    contactId: contact.id,
    dealId,
    to: contact.email,
    subject,
    body,
    contactName: contact.name,
    companyName: bundle.company?.name ?? "",
    dealStage: stageLabel,
    createdBy: userId,
    channelId,
    ...(threadTs ? { threadTs } : {}),
  });

  return {
    draft,
    to: contact.email,
    subject,
    body,
    contactName: contact.name,
    dealName,
  };
}
