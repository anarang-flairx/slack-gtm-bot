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
