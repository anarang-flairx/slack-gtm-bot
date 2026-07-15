import type { KnownBlock } from "@slack/types";
import type {
  FollowUpContact,
  OverdueTask,
  PipelineSnapshot,
  StalledDeal,
} from "./queries.js";
import {
  envInt,
  formatCurrency,
  formatDigestDate,
  hubspotRecordUrl,
} from "./format.js";

export type DigestData = {
  pipeline: PipelineSnapshot | null;
  pipelineError?: string;
  stalled: StalledDeal[] | null;
  stalledError?: string;
  followUps: FollowUpContact[] | null;
  followUpsError?: string;
  tasks: OverdueTask[] | null;
  tasksError?: string;
  moved: Array<{ id: string; name: string; toStageLabel: string }>;
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

  // Pipeline (always shown)
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
    const lines = [
      `*Pipeline:* ${p.openCount} open · ${formatCurrency(p.rawTotal)} raw · *${formatCurrency(p.weightedTotal)} weighted*`,
    ];

    if (data.moved.length > 0) {
      const movedText = data.moved
        .slice(0, 3)
        .map((m) => `*${m.name}* → ${m.toStageLabel}`)
        .join(", ");
      lines.push(`:tada: Moved: ${movedText}`);
    }

    if (p.pastCloseCount > 0) {
      lines.push(`:warning: ${p.pastCloseCount} deals past close date`);
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  const quiet =
    (!data.stalled || data.stalled.length === 0) &&
    !data.stalledError &&
    (!data.followUps || data.followUps.length === 0) &&
    !data.followUpsError &&
    (!data.tasks || data.tasks.length === 0) &&
    !data.tasksError;

  if (quiet) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ No stalled deals or late follow-ups today.",
      },
    });
    return blocks;
  }

  // Stalled
  if (data.stalledError) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ Couldn't load stalled deals (${data.stalledError})`,
      },
    });
  } else if (data.stalled && data.stalled.length > 0) {
    blocks.push({ type: "divider" });
    const { shown, more } = capRows(data.stalled);
    const lines = shown.map((deal) => {
      const url = hubspotRecordUrl("deal", deal.id);
      return `• <${url}|${deal.name} — ${formatCurrency(deal.amount)}> · ${deal.stageLabel} · *${deal.daysQuiet} days quiet*`;
    });
    if (more > 0) {
      lines.push(`_+${more} more_`);
    }
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⚠️ Stalled deals (${data.stalled.length})*\n${lines.join("\n")}`,
      },
    });
  }

  // Follow-ups
  if (data.followUpsError) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ Couldn't load follow-ups (${data.followUpsError})`,
      },
    });
  } else if (data.followUps && data.followUps.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⏰ Follow-ups due (${data.followUps.length})*`,
      },
    });

    const { shown, more } = capRows(data.followUps);
    for (const contact of shown) {
      const url = hubspotRecordUrl("contact", contact.id);
      const company = contact.companyName
        ? ` (${contact.companyName})`
        : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `• <${url}|${contact.name}>${company} · ${contact.leadStatusLabel} · *${contact.daysOverdue} days*`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Draft follow-up" },
          action_id: "draft_followup",
          value: JSON.stringify({
            contact_id: contact.id,
            template: "event-follow-up",
          }),
        },
      });
    }

    if (more > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `_+${more} more_` },
      });
    }
  }

  // Overdue tasks
  if (data.tasksError) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ Couldn't load overdue tasks (${data.tasksError})`,
      },
    });
  } else if (data.tasks && data.tasks.length > 0) {
    blocks.push({ type: "divider" });
    const { shown, more } = capRows(data.tasks);
    const lines = shown.map((task) => `• ${task.subject}`);
    if (more > 0) {
      lines.push(`_+${more} more_`);
    }
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📌 Overdue tasks (${data.tasks.length})*\n${lines.join("\n")}`,
      },
    });
  }

  return blocks;
}
