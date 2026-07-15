import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DigestState = {
  dealStages: Record<string, string>;
  updatedAt: string;
};

const statePath = join(process.cwd(), "data", "digest-state.json");

export function loadDigestState(): DigestState | null {
  try {
    const raw = readFileSync(statePath, "utf8");
    return JSON.parse(raw) as DigestState;
  } catch {
    return null;
  }
}

export function saveDigestState(dealStages: Record<string, string>): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const state: DigestState = {
    dealStages,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function diffMovedDeals(
  previous: Record<string, string> | null,
  current: Array<{ id: string; stageId: string; name: string }>,
): Array<{ id: string; name: string; fromStageId: string; toStageId: string }> {
  if (!previous) {
    return [];
  }

  const moved: Array<{
    id: string;
    name: string;
    fromStageId: string;
    toStageId: string;
  }> = [];

  for (const deal of current) {
    const prior = previous[deal.id];
    if (prior && prior !== deal.stageId) {
      moved.push({
        id: deal.id,
        name: deal.name,
        fromStageId: prior,
        toStageId: deal.stageId,
      });
    }
  }

  return moved;
}
