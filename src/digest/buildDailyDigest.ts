import type { KnownBlock } from "@slack/types";
import { getPipelineMeta } from "../integrations/hubspot.js";
import { buildDigestBlocks, type DigestData } from "./blocks.js";
import {
  queryFollowUpContacts,
  queryOpenDeals,
  queryOverdueTasks,
  queryStalledDeals,
} from "./queries.js";
import { diffMovedDeals, loadDigestState, saveDigestState } from "./state.js";

export type DailyDigestResult = {
  blocks: KnownBlock[];
  channelId: string;
};

async function safeSection<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T | null; error?: string }> {
  try {
    return { value: await fn() };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "HubSpot error";
    console.error(`[digest] ${label} failed:`, message);
    return { value: null, error: message };
  }
}

export async function buildDailyDigest(): Promise<DailyDigestResult> {
  const channelId = process.env.DIGEST_CHANNEL;
  if (!channelId) {
    throw new Error("Missing DIGEST_CHANNEL in .env (use the Slack channel ID)");
  }

  const [pipelineResult, stalledResult, followUpsResult, tasksResult] =
    await Promise.all([
      safeSection("pipeline", queryOpenDeals),
      safeSection("stalled", queryStalledDeals),
      safeSection("follow-ups", queryFollowUpContacts),
      safeSection("tasks", queryOverdueTasks),
    ]);

  const previous = loadDigestState();
  let moved: DigestData["moved"] = [];

  if (pipelineResult.value) {
    const currentStages = Object.fromEntries(
      pipelineResult.value.deals.map((deal) => [deal.id, deal.stageId]),
    );

    const movedRaw = diffMovedDeals(
      previous?.dealStages ?? null,
      pipelineResult.value.deals.map((deal) => ({
        id: deal.id,
        stageId: deal.stageId,
        name: deal.name,
      })),
    );

    try {
      const pipeline = await getPipelineMeta();
      moved = movedRaw.map((item) => ({
        id: item.id,
        name: item.name,
        toStageLabel:
          pipeline.stageById.get(item.toStageId)?.label ?? item.toStageId,
      }));
    } catch {
      moved = movedRaw.map((item) => ({
        id: item.id,
        name: item.name,
        toStageLabel: item.toStageId,
      }));
    }

    saveDigestState(currentStages);
  }

  const data: DigestData = {
    pipeline: pipelineResult.value,
    pipelineError: pipelineResult.error,
    stalled: stalledResult.value,
    stalledError: stalledResult.error,
    followUps: followUpsResult.value,
    followUpsError: followUpsResult.error,
    tasks: tasksResult.value,
    tasksError: tasksResult.error,
    moved,
  };

  return {
    blocks: buildDigestBlocks(data),
    channelId,
  };
}
