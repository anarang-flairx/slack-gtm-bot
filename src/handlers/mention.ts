import type { App } from "@slack/bolt";
import OpenAI from "openai";
import type { DraftType } from "../types/draft.js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const conversations = new Map<string, ChatMessage[]>();
const MAX_HISTORY_MESSAGES = 20;

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function registerMentionHandler(
  app: App,
  echoMode: boolean,
  openai: OpenAI | null,
): void {
  app.event("app_mention", async ({ event, client }) => {
    if (!("text" in event) || !event.text) {
      return;
    }

    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const conversationKey = `${channel}:${threadTs}`;
    const userMessage = stripBotMention(event.text);

    try {
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
                "You are FlairX GTM Bot, a helpful Slack GTM assistant for FlairX. You can draft emails with /intro-draft and /event-follow-up.",
            },
            ...history,
          ],
        });

        reply =
          completion.choices[0]?.message?.content ??
          "Sorry, I had trouble thinking of a response.";

        history.push({ role: "assistant", content: reply });
        if (history.length > MAX_HISTORY_MESSAGES) {
          history.splice(0, history.length - MAX_HISTORY_MESSAGES);
        }
        conversations.set(conversationKey, history);
      }

      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: reply,
      });
    } catch (error) {
      console.error("[mention] failed:", error);
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "Sorry, I hit an error handling that mention. Please try again.",
        });
      } catch (postError) {
        console.error("[mention] failed to post error reply:", postError);
      }
    }
  });
}

export type { DraftType };
