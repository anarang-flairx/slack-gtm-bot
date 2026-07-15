import {
  getContactContextById,
  toTemplateContext,
  type HubSpotContactContext,
} from "../integrations/hubspot.js";
import { fillTemplate, loadTemplate } from "./templateEngine.js";
import { getResourceUrlContext } from "./resourceUrls.js";
import { saveDraft } from "./draftStore.js";
import type { DraftType, PendingDraft } from "../types/draft.js";

export const TEMPLATE_FILES: Record<DraftType, string> = {
  intro: "intro-draft.md",
  "event-follow-up": "event-follow-up.md",
};

export type DraftPreview = {
  draft: PendingDraft;
  context: HubSpotContactContext;
  subject: string;
  body: string;
};

export async function createDraftByContactId(
  contactId: string,
  template: DraftType,
  userId: string,
  channelId: string,
): Promise<DraftPreview> {
  const context = await getContactContextById(contactId);
  const templateFile = TEMPLATE_FILES[template];
  if (!templateFile) {
    throw new Error(`Unknown template: ${template}`);
  }

  const filled = fillTemplate(loadTemplate(templateFile), {
    ...toTemplateContext(context),
    ...getResourceUrlContext(),
  });

  const draft = saveDraft({
    type: template,
    contactId: context.contactId,
    dealId: context.dealId,
    to: context.email,
    subject: filled.subject,
    body: filled.body,
    contactName: context.fullName,
    companyName: context.companyName,
    dealStage: context.dealStage,
    createdBy: userId,
    channelId,
  });

  return {
    draft,
    context,
    subject: filled.subject,
    body: filled.body,
  };
}
