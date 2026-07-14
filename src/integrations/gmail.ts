import { google } from "googleapis";

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

function buildMimeMessage(to: string, subject: string, body: string): string {
  const from = process.env.GMAIL_SENDER_EMAIL;
  if (!from) {
    throw new Error("Missing GMAIL_SENDER_EMAIL in .env");
  }

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
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
  const senderEmail = process.env.GMAIL_SENDER_EMAIL;

  if (!senderEmail) {
    throw new Error("Missing GMAIL_SENDER_EMAIL in .env");
  }

  await gmail.users.drafts.create({
    userId: senderEmail,
    requestBody: {
      message: {
        raw: buildMimeMessage(to, subject, body),
      },
    },
  });
}
