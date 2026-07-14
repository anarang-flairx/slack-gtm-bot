import "dotenv/config";
import { createServer } from "node:http";
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

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/gmail.compose"],
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

  const url = new URL(req.url, "http://localhost:3000");
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("Missing code");
    return;
  }

  const { tokens } = await oauth2Client.getToken(code);

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    "<h1>Success</h1><p>Copy GOOGLE_REFRESH_TOKEN into your .env, then restart the bot.</p>",
  );

  console.log("\nAdd this to your .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`GMAIL_SENDER_EMAIL=the-ceo-email-you-signed-in-with@gmail.com\n`);

  server.close();
  process.exit(0);
});

server.listen(3000, () => {
  console.log("Waiting for OAuth callback on http://localhost:3000/oauth2callback ...\n");
});
