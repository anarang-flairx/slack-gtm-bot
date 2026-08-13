import type { App } from "@slack/bolt";
import { listRecentRecordsWithActivity } from "../integrations/hubspot.js";
import { activitySnippet, classifyRecentMarketing } from "./classifyMarketing.js";
import { savePendingCleanup } from "./cleanupStore.js";
import {
  buildCleanupItemPreviewBlocks,
  buildCleanupSummaryBlocks,
} from "./previews.js";
import type {
  PendingCleanupCompany,
  PendingCleanupContact,
} from "../types/pendingCleanup.js";

export type CleanupPostContext = {
  client: App["client"];
  channel: string;
  threadTs?: string;
  userId: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scan last-N-hours contacts/companies, classify marketing activity, post a
 * summary plus one Approve/Discard card per record.
 */
export async function postRecentMarketingCleanup(
  ctx: CleanupPostContext,
  maxRecords = 40,
): Promise<{ contacts: number; companies: number; truncated: boolean }> {
  const lookbackHours = Number(process.env.CLEANUP_LOOKBACK_HOURS ?? 24) || 24;
  const createdAfterMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const { records, truncated } = await listRecentRecordsWithActivity(
    createdAfterMs,
    maxRecords,
  );
  const classified = await classifyRecentMarketing(records);

  const contacts: PendingCleanupContact[] = [];
  const companies: PendingCleanupCompany[] = [];

  for (const record of records) {
    const verdict = classified.get(`${record.objectType}:${record.id}`);
    if (!verdict?.marketing) {
      continue;
    }
    const snippet = activitySnippet(record);
    if (record.objectType === "contacts") {
      contacts.push({
        id: record.id,
        name: record.name,
        email: record.email,
        reason: verdict.reason,
        summary: verdict.summary,
        activitySnippet: snippet,
      });
    } else {
      companies.push({
        id: record.id,
        name: record.name,
        domain: record.domain,
        reason: verdict.reason,
        summary: verdict.summary,
        activitySnippet: snippet,
      });
    }
  }

  if (contacts.length === 0 && companies.length === 0) {
    return { contacts: 0, companies: 0, truncated };
  }

  await ctx.client.chat.postMessage({
    channel: ctx.channel,
    ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
    text: `Marketing cleanup: ${contacts.length} contact(s), ${companies.length} company(ies) from the last ${lookbackHours}h`,
    blocks: buildCleanupSummaryBlocks(
      contacts,
      companies,
      `last ${lookbackHours} hours`,
      truncated,
    ),
  });

  for (const contact of contacts) {
    const pending = savePendingCleanup({
      contacts: [contact],
      companies: [],
      truncated: false,
      createdBy: ctx.userId,
      channelId: ctx.channel,
      ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
    });
    await ctx.client.chat.postMessage({
      channel: ctx.channel,
      ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
      text: `Cleanup contact: ${contact.name}`,
      blocks: buildCleanupItemPreviewBlocks("contact", contact, pending.id),
    });
    await sleep(150);
  }

  for (const company of companies) {
    const pending = savePendingCleanup({
      contacts: [],
      companies: [company],
      truncated: false,
      createdBy: ctx.userId,
      channelId: ctx.channel,
      ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
    });
    await ctx.client.chat.postMessage({
      channel: ctx.channel,
      ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
      text: `Cleanup company: ${company.name}`,
      blocks: buildCleanupItemPreviewBlocks("company", company, pending.id),
    });
    await sleep(150);
  }

  return {
    contacts: contacts.length,
    companies: companies.length,
    truncated,
  };
}
