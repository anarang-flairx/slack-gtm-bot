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
import { runEmailNoteSync } from "./jobs/emailNoteLogger.js";

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

function startEmailNoteLogger(): void {
  if (echoMode || !openai) {
    return;
  }
  if (process.env.EMAIL_LOG_ENABLED !== "true") {
    return;
  }
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn(
      "[email-log] EMAIL_LOG_ENABLED=true but GOOGLE_REFRESH_TOKEN is missing; skipping. Run: npm run gmail-auth",
    );
    return;
  }

  const minutes = Number(process.env.EMAIL_LOG_POLL_MINUTES ?? 5) || 5;
  const tick = () =>
    runEmailNoteSync(openai, app.client).catch((error) =>
      console.error("[email-log] sync failed:", error),
    );

  // First run establishes a baseline; subsequent runs log new sent mail.
  setTimeout(tick, 10_000);
  setInterval(tick, minutes * 60_000);
  console.log(`[email-log] Auto-logging sent emails to notes every ${minutes}m.`);
}

(async () => {
  await app.start();
  startEmailNoteLogger();
  console.log(
    echoMode
      ? "FlairX GTM Bot running (DEV_ECHO_MODE). Mention the bot in Slack."
      : "FlairX GTM Bot running. Mention the bot in Slack to add notes, move deals, add prospects, draft emails, and query HubSpot.",
  );
})();
