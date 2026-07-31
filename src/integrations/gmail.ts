import { google } from "googleapis";
import { markdownToHtml, markdownToPlainText } from "../lib/markdownToHtml.js";

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  }

  if (!refreshToken) {
    throw new Error(
      "Missing GOOGLE_REFRESH_TOKEN. Run: npm run gmail-auth",
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

/** Strip CR/LF so HubSpot values cannot inject MIME headers. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encode a header when it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  const safe = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(safe)) {
    return safe;
  }
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function encodeBase64Body(content: string): string {
  return Buffer.from(content, "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
}

function buildMimeMessage(to: string, subject: string, body: string): string {
  const from = process.env.GMAIL_SENDER_EMAIL;
  if (!from) {
    throw new Error("Missing GMAIL_SENDER_EMAIL in .env");
  }

  const boundary = "flare_gtm_boundary";
  const plainBody = markdownToPlainText(body);
  const htmlBody = markdownToHtml(body);

  const message = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${sanitizeHeaderValue(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(plainBody),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(htmlBody),
    "",
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function createGmailDraft(
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  if (!process.env.GMAIL_SENDER_EMAIL) {
    throw new Error("Missing GMAIL_SENDER_EMAIL in .env");
  }

  await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: buildMimeMessage(to, subject, body),
      },
    },
  });
}

export type UnansweredThread = {
  threadId: string;
  to: string;
  subject: string;
  lastSentAt: string;
  daysWaiting: number;
};

export type ThreadContent = {
  threadId: string;
  subject: string;
  participants: string[];
  text: string;
};

function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  const match = headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return match?.value?.trim() ?? "";
}

function extractEmail(headerValueRaw: string): string {
  const angle = headerValueRaw.match(/<([^>]+)>/);
  return (angle ? angle[1] : headerValueRaw).trim().toLowerCase();
}

function decodeBody(data: string | null | undefined): string {
  if (!data) {
    return "";
  }
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
}

type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
};

function extractPlainText(part: GmailPart | undefined): string {
  if (!part) {
    return "";
  }
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBody(part.body.data);
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractPlainText(child);
      if (text) {
        return text;
      }
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBody(part.body.data)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

/**
 * List sent threads where the last message is ours and no reply has arrived
 * within `days`. Inspects a bounded number of recent sent threads to stay cheap.
 */
export async function listThreadsAwaitingReply(
  days = 7,
  maxThreads = 25,
): Promise<UnansweredThread[]> {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const sender = process.env.GMAIL_SENDER_EMAIL?.toLowerCase();
  if (!sender) {
    throw new Error("Missing GMAIL_SENDER_EMAIL in .env");
  }

  const list = await gmail.users.messages.list({
    userId: "me",
    q: `in:sent newer_than:${days * 4}d`,
    maxResults: 100,
  });

  const threadIds: string[] = [];
  for (const message of list.data.messages ?? []) {
    if (message.threadId && !threadIds.includes(message.threadId)) {
      threadIds.push(message.threadId);
    }
    if (threadIds.length >= maxThreads) {
      break;
    }
  }

  const now = Date.now();
  const results: UnansweredThread[] = [];

  for (const threadId of threadIds) {
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const messages = thread.data.messages ?? [];
    if (messages.length === 0) {
      continue;
    }

    const last = messages[messages.length - 1];
    const fromEmail = extractEmail(headerValue(last.payload?.headers, "From"));
    if (fromEmail !== sender) {
      continue;
    }

    const lastMs = last.internalDate ? Number(last.internalDate) : now;
    const daysWaiting = Math.floor((now - lastMs) / 86_400_000);
    if (daysWaiting < days) {
      continue;
    }

    results.push({
      threadId,
      to: headerValue(last.payload?.headers, "To"),
      subject: headerValue(last.payload?.headers, "Subject") || "(no subject)",
      lastSentAt: new Date(lastMs).toISOString().slice(0, 10),
      daysWaiting,
    });
  }

  return results.sort((a, b) => b.daysWaiting - a.daysWaiting);
}

/** Fetch a thread's text content, truncated to keep token cost bounded. */
export async function getThreadContent(
  threadId: string,
  maxChars = 8000,
): Promise<ThreadContent> {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = thread.data.messages ?? [];
  const participants = new Set<string>();
  const segments: string[] = [];
  let subject = "";

  for (const message of messages) {
    const headers = message.payload?.headers;
    if (!subject) {
      subject = headerValue(headers, "Subject");
    }
    const from = headerValue(headers, "From");
    const date = headerValue(headers, "Date");
    if (from) {
      participants.add(from);
    }
    const body = extractPlainText(message.payload as GmailPart);
    segments.push(`From: ${from}\nDate: ${date}\n\n${body}`.trim());
  }

  let text = segments.join("\n\n---\n\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n...(truncated)`;
  }

  return {
    threadId,
    subject: subject || "(no subject)",
    participants: [...participants],
    text,
  };
}
