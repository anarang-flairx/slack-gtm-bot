import "dotenv/config";
import { App } from "@slack/bolt";
import OpenAI from "openai";
import { registerDraftCommands } from "./handlers/draftEmail.js";
import { registerEmailActions } from "./handlers/emailActions.js";
import { registerMentionHandler } from "./handlers/mention.js";

const echoMode = process.env.DEV_ECHO_MODE === "true";

const requiredEnv = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (!echoMode && !process.env.OPENAI_API_KEY) {
  throw new Error(
    "Missing required environment variable: OPENAI_API_KEY (or set DEV_ECHO_MODE=true to test without OpenAI)",
  );
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const openai = echoMode
  ? null
  : new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

registerMentionHandler(app, echoMode, openai);
registerDraftCommands(app);
registerEmailActions(app);

(async () => {
  await app.start();
  console.log(
    echoMode
      ? "FlairX GTM Bot running (DEV_ECHO_MODE). Email drafts: /initial-draft, /follow-up-draft"
      : "FlairX GTM Bot running. Email drafts: /initial-draft, /follow-up-draft",
  );
})();
