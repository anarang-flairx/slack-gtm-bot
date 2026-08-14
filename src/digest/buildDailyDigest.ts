import type { KnownBlock } from "@slack/types";
import { buildDigestBlocks, type DigestData } from "./blocks.js";
import {
  queryDealsNeedingFollowUp,
  queryOpenDeals,
} from "./queries.js";

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

  const pipelineResult = await safeSection("pipeline", queryOpenDeals);

  let followUps: DigestData["followUps"] = null;
  let followUpsError: string | undefined;

  if (pipelineResult.value) {
    const followResult = await safeSection("deal-follow-ups", () =>
      queryDealsNeedingFollowUp(pipelineResult.value!.deals),
    );
    followUps = followResult.value;
    followUpsError = followResult.error;
  } else {
    followUpsError = pipelineResult.error;
  }

  const data: DigestData = {
    pipeline: pipelineResult.value,
    pipelineError: pipelineResult.error,
    followUps,
    followUpsError,
  };

  return {
    blocks: buildDigestBlocks(data),
    channelId,
  };
}
