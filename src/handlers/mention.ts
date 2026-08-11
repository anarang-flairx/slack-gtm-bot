import type { App } from "@slack/bolt";
import type OpenAI from "openai";
import { executeTool, toolDefinitions, type ToolContext } from "../agent/tools.js";
import {
  fetchSlackImageAsDataUrl,
  imageFilesFrom,
  type SlackFile,
} from "../lib/slackFiles.js";
import { extractLeadsFromImages } from "../lib/visionExtract.js";

type StoredMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const conversations = new Map<string, StoredMessage[]>();
const MAX_HISTORY_MESSAGES = 10;
const MAX_TOOL_ITERATIONS = 8;
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";
// Short confirmations/answers ("yes", "the first one") route to a cheaper model.
const CHEAP_MODEL = process.env.OPENAI_CHEAP_MODEL ?? "gpt-4.1-mini";
const TRIVIAL_REPLY_MAX_WORDS = 6;

const SYSTEM_PROMPT = `You are FlairX GTM Bot, a go-to-market assistant that lives in Slack for FlairX (an AI interview platform). The team mentions you in plain English and you take GTM actions in HubSpot and Gmail.

You can:
- Answer questions about the sales pipeline stages, contact lead statuses, and company lifecycle stages.
- List companies in a lifecycle stage (e.g. all Customers).
- Look up records and post a company status card (deals, contacts, notes, last activity).
- Add a dated note to a contact, company, or deal (this also refreshes the last-activity date).
- Change a contact's lead status (e.g. to Connected).
- Add a new contact (+ optional company), or a full prospect with a deal in Prospecting when explicitly requested.
- Create a deal on an existing company (named "[Company] - FlairX") and associate all of that company's contacts.
- Move a deal to a different pipeline stage.
- Set a follow-up reminder in N days (creates a HubSpot task + a scheduled Slack nudge).
- Draft templated or custom emails into Gmail Drafts, and find sent emails that have not been replied to.
- Summarize an email thread into notes on the matching contact and its company.

Rules:
- A single request can require multiple actions — call each relevant tool. For example, "update notes for Acme — demoed today, and remind me to follow up in 2 days" should call both update_notes and schedule_follow_up, producing two approval cards.
- Every action that writes to HubSpot or Gmail posts an approval card with Approve/Discard buttons. You never complete a write yourself; after calling a write tool, tell the user you posted a preview for them to approve. Do not claim a record was created, moved, or drafted — only that a preview is ready.
- The bot never sends email; drafts are saved to Gmail Drafts for a human to send.
- The approval card IS the confirmation step. Never ask the user to verbally confirm an action before you post its card (do not say "just to confirm" or "shall I proceed?"). As soon as you know what to do, call the tool so the card appears; the user confirms by clicking Approve.
- Disambiguation happens at most once. When a tool reports multiple matches, present them to the user as a NUMBERED list exactly like "1. ...", "2. ...", and ask them to "reply with the number". Do not list the internal ids. When the user replies with a number (or otherwise names one), immediately call the tool again for that specific record — do NOT ask another clarifying or confirmation question. Never re-ask something the user already answered.
- Changing a contact's lead status is a CONTACT action — use update_lead_status, not notes and not deals. Do not offer a deal as an option for a lead-status change.
- To add someone to HubSpot, default to add_contact (contact + optional company, no deal). Use add_prospect only when the user explicitly asks for a new person as a prospect/deal.
- When the user asks to move/add a *company* to deals/pipeline (e.g. "move ColigoMed to deals", "create a deal for Acme"), use create_company_deal. Deal name is always "[Company] - FlairX". Associate ALL existing company contacts automatically — do not ask which contacts to add, do not ask for a deal name, and default the stage to Prospecting unless the user specifies another stage. Only ask a clarifying question if the company match is ambiguous or they say to move an existing deal from elsewhere.
- The conversation may span several Slack messages in a thread. Follow-ups in the same thread (without another @mention) continue this conversation. Use the prior turns as context: if you asked a clarifying question and the user answers ("yes", "the first one", an email, "1", "let's create a new one", etc.), act on it using the earlier context instead of starting over. Never reply with a generic greeting mid-conversation.
- When you post a card (e.g. company status), keep your text reply short since the card carries the detail.
- To move a deal "forward" or to the "next" stage, first call get_pipeline_stages and get the current stage (via get_company_status or search_records), then pass the exact next stage label.
- To draft a context-aware follow-up to an unanswered email, use list_unanswered_emails, then get_email_thread, then draft_custom_email with a body referencing that thread.
- Stay within GTM scope. Be concise.`;

const HELP_TEXT = `*FlairX GTM Bot — here's what I can do* :robot_face:

*Ask / look up*
• Pipeline stages — _"what are the sales pipeline stages?"_
• Lead statuses — _"what lead statuses do we have?"_
• Company lifecycle stages — _"what lifecycle stages do companies have?"_
• List companies by stage — _"show me all customers"_ or _"which companies are in the Customer stage?"_
• Find a record — _"look up Acme Corp"_
• Company status — _"what's the status of Acme Corp?"_ (deals, contacts, notes, last activity)
• Daily digest — _"post the digest"_ (pipeline snapshot, stalled deals, follow-ups due, overdue tasks)

*Capture leads from photos*
• Send a badge or business-card photo (with an optional note like _"met at SaaStr, wants a demo"_) and I'll read the details and post an add-contact card. Multiple people in one photo? I'll post one card each.
• Send a screenshot of a WhatsApp/LinkedIn message and I'll pull out the sender as a new contact.

*Update HubSpot*
• Add a contact — _"add Jane Doe at Acme to HubSpot"_ (contact + optional company; no deal)
• Add a full prospect — _"add Jane as a prospect with a deal"_ (contact + company + Prospecting deal)
• Create a company deal — _"move ColigoMed to deals"_ (deal named _Company - FlairX_, all company contacts associated)
• Add a note — _"add a note to Acme Corp — demoed today, wants pricing"_ (also refreshes last-activity date)
• Change lead status — _"set Navin Chugh's lead status to Connected"_
• Move a deal stage — _"move the Acme deal to Negotiation"_

*Reminders*
• Follow-up reminder — _"remind me to follow up with Acme in 2 days"_ (creates a HubSpot task + a scheduled Slack nudge)

*Email (drafts only — I never send)*
• Templated draft — _"draft an intro email to Jane Doe"_ or _"event follow-up to Jane Doe"_
• Custom draft — _"draft a follow-up to jane@acme.com about scheduling the demo"_
• Find unanswered — _"who hasn't replied to my emails?"_
• Summarize a thread into notes — _"summarize Jane's last email into her notes"_

*Tips*
• After the first @mention, keep chatting in the thread — no need to tag me again.
• You can combine actions: _"add a note to Acme — great demo, and remind me to follow up in 2 days"_.
• If several records match, I'll show a numbered list — just reply with the number.
• Type _help_ anytime to see this again.`;

function isHelpRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[?!.]+$/, "");
  return (
    normalized === "help" ||
    normalized === "help me" ||
    normalized === "commands" ||
    normalized === "menu" ||
    normalized === "what can you do" ||
    normalized === "what can you do for me"
  );
}

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

/** Short answers/confirmations that don't need the flagship model. */
function isTrivialReply(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= TRIVIAL_REPLY_MAX_WORDS;
}

/**
 * Runs one agent turn for a conversation identified by (channel, threadTs).
 * Replies are always posted into that thread so follow-up messages in the same
 * thread map back to the same stored history.
 */
async function runAgentTurn(
  client: App["client"],
  openai: OpenAI | null,
  echoMode: boolean,
  params: {
    channel: string;
    threadTs: string;
    userMessage: string;
    userId: string;
  },
): Promise<void> {
  const { channel, threadTs, userMessage, userId } = params;
  const conversationKey = `${channel}:${threadTs}`;

  // Seed early so plain thread replies are accepted while this turn runs.
  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, []);
  }

  const post = (text: string) =>
    client.chat.postMessage({ channel, thread_ts: threadTs, text });

  let workingTs: string | undefined;

  const finish = async (text: string) => {
    if (workingTs) {
      try {
        await client.chat.update({
          channel,
          ts: workingTs,
          text,
        });
        return;
      } catch (error) {
        console.error("[agent] failed to update working reply:", error);
      }
    }
    await post(text);
  };

  try {
    if (!userMessage) {
      await post(
        "Hey! Mention me with a request, e.g. _add a note to Acme Corp — demoed today_ or _who hasn't replied to my emails this week?_ — or say *help* to see everything I can do.",
      );
      return;
    }

    if (echoMode) {
      await post(`Echo: ${userMessage}`);
      return;
    }

    // Fast-path: "help" is deterministic, so skip the model entirely.
    if (isHelpRequest(userMessage)) {
      await post(HELP_TEXT);
      return;
    }

    const working = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "⏳ Working on it…",
    });
    workingTs = working.ts;

    const history = conversations.get(conversationKey) ?? [];
    history.push({ role: "user", content: userMessage });

    const messages: StoredMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];

    const ctx: ToolContext = {
      client,
      channel,
      threadTs,
      userId,
    };
    // Short follow-ups ("yes", "the first one") use the cheaper model; the
    // full thread history still gives it the context it needs to act.
    const model = isTrivialReply(userMessage) ? CHEAP_MODEL : MODEL;
    let reply = "";

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const completion = await openai!.chat.completions.create({
        model,
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

    // Persist only plain user/assistant turns so trimming can't orphan a
    // tool message (which would break the next OpenAI request).
    history.push({ role: "assistant", content: reply });
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    conversations.set(conversationKey, history);

    await finish(reply);
  } catch (error) {
    console.error("[agent] turn failed:", error);
    try {
      await finish("Sorry, I hit an error handling that. Please try again.");
    } catch (postError) {
      console.error("[agent] failed to post error reply:", postError);
    }
  }
}

/**
 * Handles a mention/message that includes image attachments: downloads each
 * image, runs vision OCR to extract lead(s) from badges/business cards or
 * WhatsApp/LinkedIn screenshots, and posts an add-prospect approval card per
 * person found. Approval creates the full contact + company + deal.
 */
async function runImageCapture(
  client: App["client"],
  openai: OpenAI | null,
  params: {
    channel: string;
    threadTs: string;
    files: SlackFile[];
    context: string;
    userId: string;
  },
): Promise<void> {
  const { channel, threadTs, files, context, userId } = params;
  const conversationKey = `${channel}:${threadTs}`;
  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, []);
  }

  const post = (text: string) =>
    client.chat.postMessage({ channel, thread_ts: threadTs, text });

  if (!openai) {
    await post("Image scanning needs OpenAI, which isn't configured right now.");
    return;
  }

  let workingTs: string | undefined;
  try {
    const working = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "⏳ Working on it…",
    });
    workingTs = working.ts;

    const finish = async (text: string) => {
      if (workingTs) {
        try {
          await client.chat.update({ channel, ts: workingTs, text });
          return;
        } catch (error) {
          console.error("[image-capture] failed to update working reply:", error);
        }
      }
      await post(text);
    };

    const botToken = process.env.SLACK_BOT_TOKEN ?? "";
    const dataUrls: string[] = [];
    for (const file of files) {
      const url = await fetchSlackImageAsDataUrl(file, botToken);
      if (url) {
        dataUrls.push(url);
      }
    }

    if (dataUrls.length === 0) {
      await finish("I couldn't download those images. Please try again.");
      return;
    }

    const leads = await extractLeadsFromImages(openai, dataUrls, context);
    if (leads.length === 0) {
      await finish(
        "I couldn't read any contact details from that. Try a clearer photo, or just type the details and I'll add them.",
      );
      return;
    }

    const ctx: ToolContext = { client, channel, threadTs, userId };
    for (const lead of leads) {
      const args: Record<string, unknown> = {
        first_name: lead.firstName,
        last_name: lead.lastName,
        company_name: lead.company,
        email: lead.email,
        phone: lead.phone,
        mobile: lead.mobile,
        title: lead.title,
        linkedin: lead.linkedin,
        source: lead.source || context || undefined,
        notes: lead.notes,
      };
      await executeTool("add_contact", args, ctx);
    }

    await finish(
      leads.length === 1
        ? "Found 1 lead — review the card above and click Approve to add the contact to HubSpot."
        : `Found ${leads.length} leads — review the cards above and Approve the ones you want as contacts in HubSpot.`,
    );
  } catch (error) {
    console.error("[image-capture] failed:", error);
    try {
      if (workingTs) {
        await client.chat.update({
          channel,
          ts: workingTs,
          text: "Sorry, I hit an error reading those images. Please try again.",
        });
      } else {
        await post("Sorry, I hit an error reading those images. Please try again.");
      }
    } catch {
      await post("Sorry, I hit an error reading those images. Please try again.");
    }
  }
}

export function registerMentionHandler(
  app: App,
  echoMode: boolean,
  openai: OpenAI | null,
): void {
  // Direct @mention: starts a conversation (or continues one when mentioned
  // inside an existing thread). Replies are threaded on the mention so later
  // messages in that thread continue the same conversation.
  app.event("app_mention", async ({ event, client }) => {
    if (!("text" in event) || !event.text) {
      return;
    }

    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;
    const userMessage = stripBotMention(event.text);
    const userId = event.user ?? "";

    // Mark the thread active immediately so follow-ups without @mention work
    // even while this turn is still running.
    const conversationKey = `${channel}:${threadTs}`;
    if (!conversations.has(conversationKey)) {
      conversations.set(conversationKey, []);
    }

    // Photos of badges/business cards or WhatsApp/LinkedIn screenshots →
    // vision OCR + add-prospect cards.
    const images = imageFilesFrom(event as unknown as { files?: SlackFile[] });
    if (images.length > 0) {
      await runImageCapture(client, openai, {
        channel,
        threadTs,
        files: images,
        context: userMessage,
        userId,
      });
      return;
    }

    await runAgentTurn(client, openai, echoMode, {
      channel,
      threadTs,
      userMessage,
      userId,
    });
  });

  // Plain messages inside a thread the bot is already engaged in: continue the
  // conversation without requiring another @mention (e.g. answering "yes").
  app.event("message", async ({ event, client, context }) => {
    const msg = event as {
      subtype?: string;
      text?: string;
      user?: string;
      bot_id?: string;
      thread_ts?: string;
      ts: string;
      channel: string;
      files?: SlackFile[];
    };

    // Ignore bot messages; allow normal messages and file uploads only.
    if (msg.bot_id) {
      return;
    }
    if (msg.subtype && msg.subtype !== "file_share") {
      return;
    }
    // Only continue threaded replies.
    if (!msg.thread_ts) {
      return;
    }
    // Mentions are handled by app_mention; skip to avoid double replies.
    const botUserId = context.botUserId;
    if (botUserId && (msg.text ?? "").includes(`<@${botUserId}>`)) {
      return;
    }
    // Only respond in threads the bot is actively part of.
    const conversationKey = `${msg.channel}:${msg.thread_ts}`;
    if (!conversations.has(conversationKey)) {
      return;
    }

    // Images dropped into an active thread → vision OCR + add-prospect cards.
    const images = imageFilesFrom(msg);
    if (images.length > 0) {
      await runImageCapture(client, openai, {
        channel: msg.channel,
        threadTs: msg.thread_ts,
        files: images,
        context: (msg.text ?? "").trim(),
        userId: msg.user ?? "",
      });
      return;
    }

    if (!msg.text) {
      return;
    }

    await runAgentTurn(client, openai, echoMode, {
      channel: msg.channel,
      threadTs: msg.thread_ts,
      userMessage: msg.text.trim(),
      userId: msg.user ?? "",
    });
  });
}
