export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return "$—";
  }

  const abs = Math.abs(amount);
  if (abs >= 1_000_000) {
    return `$${Math.round(amount / 100_000) / 10}M`;
  }
  if (abs >= 1_000) {
    return `$${Math.round(amount / 1000)}k`;
  }
  return `$${Math.round(amount)}`;
}

export function daysSince(timestampMs: number | null, nowMs = Date.now()): number {
  if (!timestampMs) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - timestampMs) / 86_400_000));
}

export function daysAgoMs(days: number, nowMs = Date.now()): number {
  return nowMs - days * 86_400_000;
}

export function startOfTodayMs(timeZone = "America/Los_Angeles"): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  // Approximate midnight PT as UTC-7/8; good enough for close-date comparisons
  return Date.parse(`${year}-${month}-${day}T00:00:00-07:00`);
}

export function formatDigestDate(now = new Date()): string {
  return now.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
  });
}

export function hubspotRecordUrl(
  objectType: "contact" | "deal" | "company",
  id: string,
): string {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const host = process.env.HUBSPOT_APP_HOST ?? "app.hubspot.com";

  if (!portalId) {
    return `https://${host}`;
  }

  const typeId =
    objectType === "contact" ? "0-1" : objectType === "company" ? "0-2" : "0-3";
  return `https://${host}/contacts/${portalId}/record/${typeId}/${id}`;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
