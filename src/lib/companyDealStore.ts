import { randomUUID } from "node:crypto";
import type {
  PendingCompanyDeal,
  TakeCompanyDealResult,
} from "../types/pendingCompanyDeal.js";

/** Pending company-deal creates expire after 30 minutes. */
export const COMPANY_DEAL_TTL_MS = 30 * 60 * 1000;

const pendingDeals = new Map<string, PendingCompanyDeal>();
const inFlight = new Set<string>();

function isExpired(pending: PendingCompanyDeal, now = Date.now()): boolean {
  return now - pending.createdAt > COMPANY_DEAL_TTL_MS;
}

function purgeExpired(now = Date.now()): void {
  for (const [id, pending] of pendingDeals) {
    if (isExpired(pending, now)) {
      pendingDeals.delete(id);
      inFlight.delete(id);
    }
  }
}

export function savePendingCompanyDeal(
  pending: Omit<PendingCompanyDeal, "id" | "createdAt">,
): PendingCompanyDeal {
  purgeExpired();

  const record: PendingCompanyDeal = {
    ...pending,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  pendingDeals.set(record.id, record);
  return record;
}

export function beginCompanyDealAction(
  id: string,
  userId: string,
): TakeCompanyDealResult {
  purgeExpired();
  const pending = pendingDeals.get(id);

  if (!pending || isExpired(pending)) {
    if (pending) {
      pendingDeals.delete(id);
      inFlight.delete(id);
    }
    return { status: "not_found" };
  }

  if (pending.createdBy !== userId) {
    return { status: "forbidden" };
  }

  if (inFlight.has(id)) {
    return { status: "not_found" };
  }

  inFlight.add(id);
  return { status: "ok", pending };
}

export function completeCompanyDealAction(id: string): void {
  pendingDeals.delete(id);
  inFlight.delete(id);
}

export function releaseCompanyDealAction(id: string): void {
  inFlight.delete(id);
}

export function takeCompanyDeal(
  id: string,
  userId: string,
): TakeCompanyDealResult {
  const result = beginCompanyDealAction(id, userId);
  if (result.status === "ok") {
    completeCompanyDealAction(id);
  }
  return result;
}
