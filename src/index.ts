import "dotenv/config";
import { App } from "@slack/bolt";
import OpenAI from "openai";
import { registerCompanyDealActions } from "./handlers/companyDealActions.js";
import { registerCleanupActions } from "./handlers/cleanupActions.js";
import { registerDigestActions } from "./handlers/digestActions.js";
import { registerEmailActions } from "./handlers/emailActions.js";
import { registerMentionHandler } from "./handlers/mention.js";
import { registerNoteActions } from "./handlers/noteActions.js";
import { registerLeadStatusActions } from "./handlers/leadStatusActions.js";
import { registerProspectActions } from "./handlers/prospectActions.js";
import { registerReminderActions } from "./handlers/reminderActions.js";
import { registerStageMoveActions } from "./handlers/stageMoveActions.js";
import { startMarketingCleanupScheduler } from "./jobs/marketingCleanup.js";

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

// @mention is the only interface. These register the mention agent loop plus
// the Approve/Discard button handlers the agent's preview cards rely on.
registerMentionHandler(app, echoMode, openai);
registerEmailActions(app);
registerNoteActions(app);
registerProspectActions(app);
registerCompanyDealActions(app);
registerStageMoveActions(app);
registerReminderActions(app);
registerLeadStatusActions(app);
registerCleanupActions(app);
registerDigestActions(app);

(async () => {
  await app.start();
  startMarketingCleanupScheduler(app.client);
  console.log(
    echoMode
      ? "FlairX GTM Bot running (DEV_ECHO_MODE). Mention the bot in Slack."
      : "FlairX GTM Bot running. Mention the bot in Slack to add notes, move deals, add prospects, draft emails, and query HubSpot.",
  );
})();
