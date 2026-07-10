import "dotenv/config";
import { App } from "@slack/bolt";
import OpenAI from "openai";

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const conversations = new Map<string, ChatMessage[]>();

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

app.event("app_mention", async ({ event, client }) => {
  if (!("text" in event) || !event.text) {
    return;
  }

  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const conversationKey = `${channel}:${threadTs}`;
  const userMessage = stripBotMention(event.text);

  if (!userMessage) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Hey! Mention me with a message and I'll reply here.",
    });
    return;
  }

  let reply: string;

  if (echoMode) {
    reply = `Echo: ${userMessage}`;
  } else {
    const history = conversations.get(conversationKey) ?? [];
    history.push({ role: "user", content: userMessage });

    const completion = await openai!.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Flare, a helpful Slack GTM assistant for FlairX. For now, only hold simple conversations. Do not claim to access HubSpot, Apollo, Gmail, badge scanning, WhatsApp, or LinkedIn yet.",
        },
        ...history,
      ],
    });

    reply =
      completion.choices[0]?.message?.content ??
      "Sorry, I had trouble thinking of a response.";

    history.push({ role: "assistant", content: reply });
    conversations.set(conversationKey, history);
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: reply,
  });
});

(async () => {
  await app.start();
  console.log(
    echoMode
      ? "Flare Slack bot is running in Socket Mode (DEV_ECHO_MODE)"
      : "Flare Slack bot is running in Socket Mode",
  );
})();
