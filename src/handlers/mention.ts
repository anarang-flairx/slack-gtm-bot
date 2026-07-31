import type { App } from "@slack/bolt";
import type OpenAI from "openai";
import { executeTool, toolDefinitions, type ToolContext } from "../agent/tools.js";

type StoredMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const conversations = new Map<string, StoredMessage[]>();
const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_ITERATIONS = 8;
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

const SYSTEM_PROMPT = `You are FlairX GTM Bot, a go-to-market assistant that lives in Slack for FlairX (an AI interview platform). The team mentions you in plain English and you take GTM actions in HubSpot and Gmail.

You can:
- Answer questions about the sales pipeline stages and contact lead statuses.
- Look up records and post a company status card (deals, contacts, notes, last activity).
- Add a dated note to a contact, company, or deal (this also refreshes the last-activity date).
- Add a new prospect (contact + optional company + a deal in Prospecting).
- Move a deal to a different pipeline stage.
- Draft templated or custom emails into Gmail Drafts, and find sent emails that have not been replied to.
- Summarize an email thread into notes on the matching contact and its company.

Rules:
- Every action that writes to HubSpot or Gmail posts an approval card with Approve/Discard buttons. You never complete a write yourself; after calling a write tool, tell the user you posted a preview for them to approve. Do not claim a record was created, moved, or drafted — only that a preview is ready.
- The bot never sends email; drafts are saved to Gmail Drafts for a human to send.
- When a tool reports multiple matches, ask the user a short clarifying question listing the options. Do not guess.
- When you post a card (e.g. company status), keep your text reply short since the card carries the detail.
- To move a deal "forward" or to the "next" stage, first call get_pipeline_stages and get the current stage (via get_company_status or search_records), then pass the exact next stage label.
- To draft a context-aware follow-up to an unanswered email, use list_unanswered_emails, then get_email_thread, then draft_custom_email with a body referencing that thread.
- Stay within GTM scope. Be concise.`;

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
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
    // Only thread when the mention is already inside a thread; otherwise reply
    // as a normal channel message.
    const replyThreadTs = event.thread_ts;
    const conversationKey = `${channel}:${event.thread_ts ?? event.ts}`;
    const userMessage = stripBotMention(event.text);
    const userId = event.user ?? "";

    const post = (text: string) =>
      client.chat.postMessage({
        channel,
        ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
        text,
      });

    try {
      if (!userMessage) {
        await post(
          "Hey! Mention me with a request, e.g. `@FlairX GTM Bot add a note to Acme Corp — demoed today` or `who hasn't replied to my emails this week?`",
        );
        return;
      }

      if (echoMode) {
        await post(`Echo: ${userMessage}`);
        return;
      }

      const history = conversations.get(conversationKey) ?? [];
      history.push({ role: "user", content: userMessage });

      const messages: StoredMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ];

      const ctx: ToolContext = {
        client,
        channel,
        ...(replyThreadTs ? { threadTs: replyThreadTs } : {}),
        userId,
      };
      let reply = "";

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const completion = await openai!.chat.completions.create({
          model: MODEL,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
        });

        const choice = completion.choices[0]?.message;
        if (!choice) {
          reply = "Sorry, I had trouble thinking of a response.";
          break;
        }

        messages.push(choice);

        if (choice.tool_calls && choice.tool_calls.length > 0) {
          for (const call of choice.tool_calls) {
            if (call.type !== "function") {
              continue;
            }
            let result: string;
            try {
              result = await executeTool(
                call.function.name,
                parseArgs(call.function.arguments),
                ctx,
              );
            } catch (error) {
              result =
                error instanceof Error
                  ? `Error: ${error.message}`
                  : "Error running that action.";
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
          }
          continue;
        }

        reply =
          typeof choice.content === "string" && choice.content.trim()
            ? choice.content
            : "Done.";
        break;
      }

      if (!reply) {
        reply =
          "I wasn't able to finish that in a reasonable number of steps. Could you narrow the request?";
      }

      history.push({ role: "assistant", content: reply });
      if (history.length > MAX_HISTORY_MESSAGES) {
        history.splice(0, history.length - MAX_HISTORY_MESSAGES);
      }
      conversations.set(conversationKey, history);

      await post(reply);
    } catch (error) {
      console.error("[mention] failed:", error);
      try {
        await post(
          "Sorry, I hit an error handling that mention. Please try again.",
        );
      } catch (postError) {
        console.error("[mention] failed to post error reply:", postError);
      }
    }
  });
}
