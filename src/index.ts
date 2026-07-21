import "dotenv/config";
import { App } from "@slack/bolt";
import OpenAI from "openai";
import { registerAddProspectCommand } from "./handlers/addProspect.js";
import { registerCurrentStatusCommand } from "./handlers/currentStatus.js";
import { registerDigestCommand } from "./handlers/digest.js";
import { registerDigestActions } from "./handlers/digestActions.js";
import { registerDraftCommands } from "./handlers/draftEmail.js";
import { registerEmailActions } from "./handlers/emailActions.js";
import { registerMentionHandler } from "./handlers/mention.js";
import { registerNoteActions } from "./handlers/noteActions.js";
import { registerProspectActions } from "./handlers/prospectActions.js";
import { registerUpdateNotesCommand } from "./handlers/updateNotes.js";

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

const COMMANDS =
  "/intro-draft, /event-follow-up, /update-notes, /digest, /current-status, /add-prospect";

registerMentionHandler(app, echoMode, openai);
registerDraftCommands(app);
registerEmailActions(app);
registerUpdateNotesCommand(app);
registerNoteActions(app);
registerDigestCommand(app);
registerDigestActions(app);
registerCurrentStatusCommand(app);
registerAddProspectCommand(app);
registerProspectActions(app);

(async () => {
  await app.start();
  console.log(
    echoMode
      ? `FlairX GTM Bot running (DEV_ECHO_MODE). Commands: ${COMMANDS}`
      : `FlairX GTM Bot running. Commands: ${COMMANDS}`,
  );
})();
