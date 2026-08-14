import type { KnownBlock, SectionBlock } from "@slack/types";
import type { DealFollowUp, PipelineSnapshot } from "./queries.js";
import {
  envInt,
  formatCurrency,
  formatDigestDate,
  hubspotRecordUrl,
} from "./format.js";

export type DigestData = {
  pipeline: PipelineSnapshot | null;
  pipelineError?: string;
  followUps: DealFollowUp[] | null;
  followUpsError?: string;
};

function capRows<T>(rows: T[]): { shown: T[]; more: number } {
  const max = envInt("DIGEST_MAX_ROWS", 8);
  if (rows.length <= max) {
    return { shown: rows, more: 0 };
  }
  return { shown: rows.slice(0, max), more: rows.length - max };
}

export function buildDigestBlocks(data: DigestData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `FlairX GTM Daily — ${formatDigestDate()}`,
      },
    },
  ];

  if (data.pipelineError) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ Couldn't load pipeline (${data.pipelineError})`,
      },
    });
  } else if (data.pipeline) {
    const p = data.pipeline;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Pipeline:* ${p.openCount} open · ${formatCurrency(p.rawTotal)} raw · *${formatCurrency(p.weightedTotal)} weighted*`,
      },
    });
  }

  if (data.followUpsError) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ Couldn't load deal follow-ups (${data.followUpsError})`,
      },
    });
    return blocks;
  }

  const followUps = data.followUps ?? [];
  blocks.push({ type: "divider" });

  if (followUps.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ No deals need a follow-up today.",
      },
    });
    return blocks;
  }

  const { shown, more } = capRows(followUps);
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Deals to follow up (${followUps.length})*`,
    },
  });

  for (const deal of shown) {
    const url = hubspotRecordUrl("deal", deal.id);
    const why = deal.why.replace(/\s+/g, " ").trim();
    const section: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `• <${url}|${deal.name}> · ${deal.stageLabel} · *${deal.daysQuiet}d quiet*\n${why}`,
      },
    };
    if (deal.canDraft) {
      section.accessory = {
        type: "button",
        text: { type: "plain_text", text: "Draft follow-up" },
        action_id: "draft_deal_followup",
        value: JSON.stringify({ deal_id: deal.id }),
      };
    }
    blocks.push(section);
  }

  if (more > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `_+${more} more_` },
    });
  }

  return blocks;
}
