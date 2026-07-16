import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first");
}

const redirectUri = "http://localhost:3000/oauth2callback";
const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri,
);

const oauthState = randomBytes(24).toString("hex");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.compose"],
  state: oauthState,
});

console.log("\n1. Open this URL in your browser and sign in as the CEO Gmail account:\n");
console.log(authUrl);
console.log(
  "\n2. After approving, you will be redirected to localhost.\n",
);

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost:3000");
    const error = url.searchParams.get("error");
    if (error) {
      const description =
        url.searchParams.get("error_description") ?? "Authorization failed";
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        `<h1>OAuth error</h1><p>${escapeHtml(error)}: ${escapeHtml(description)}</p>`,
      );
      console.error(`\nOAuth error: ${error} — ${description}\n`);
      server.close();
      process.exit(1);
      return;
    }

    const state = url.searchParams.get("state");
    if (!state || state !== oauthState) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        "<h1>Invalid state</h1><p>CSRF check failed. Restart gmail-auth and try again.</p>",
      );
      console.error("\nOAuth state mismatch — possible CSRF. Aborting.\n");
      server.close();
      process.exit(1);
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Missing code</h1>");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        "<h1>No refresh token</h1><p>Google did not return a refresh token. Revoke prior access at https://myaccount.google.com/permissions and run again with prompt=consent.</p>",
      );
      console.error(
        "\nNo refresh_token in response. Revoke the app's access and re-run npm run gmail-auth.\n",
      );
      server.close();
      process.exit(1);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Success</h1><p>Copy GOOGLE_REFRESH_TOKEN into your .env, then restart the bot.</p>",
    );

    console.log("\nAdd this to your .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GMAIL_SENDER_EMAIL=the-ceo-email-you-signed-in-with@gmail.com\n`);

    server.close();
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(
      `<h1>Token exchange failed</h1><p>${escapeHtml(message)}</p>`,
    );
    console.error("\nToken exchange failed:", message, "\n");
    server.close();
    process.exit(1);
  }
});

server.listen(3000, "127.0.0.1", () => {
  console.log("Waiting for OAuth callback on http://localhost:3000/oauth2callback ...\n");
});
