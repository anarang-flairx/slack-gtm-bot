import type { App } from "@slack/bolt";
import type OpenAI from "openai";
import { executeTool, runCleanupMarketing, toolDefinitions, type ToolContext } from "../agent/tools.js";
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
- Clean up inbound marketing / Conversations auto-created contacts and orphan companies (cleanup_marketing_records — approval required).

Rules:
- VOICE (strict — overrides everything else for user-visible text):
  • Default reply: 1–2 short sentences. Never write paragraphs.
  • Forbidden: "It looks like", "Would you like", "Please confirm", "Let me know if", "I will now proceed", "Before I can", re-asking something already answered, asking for company lifecycle when creating a deal.
  • After any approval card: say only "Review the card above — Approve or Discard." (or ≤8 words). Do not describe card fields.
  • Numbered disambiguation: one-line prompt, then EACH option on its own line (never "1. A 2. B 3. C" on one line). No preamble or recap. If a tool already posted the list to Slack, do not restate it.
  • Errors/blockers: one sentence — what failed + what to do next. No apologies or repetition.
  • Tool results are internal; translate them into minimal user text. Never paste tool instructions verbatim.
- A single request can require multiple actions — call each relevant tool. For example, "update notes for Acme — demoed today, and remind me to follow up in 2 days" should call both update_notes and schedule_follow_up, producing two approval cards.
- Every action that writes to HubSpot or Gmail posts an approval card with Approve/Discard buttons. You never complete a write yourself; after calling a write tool, tell the user a preview is ready (briefly). Do not claim a record was created, moved, or drafted — only that a preview is ready.
- The bot never sends email; drafts are saved to Gmail Drafts for a human to send.
- The approval card IS the confirmation step. Never ask the user to verbally confirm an action before you post its card (do not say "just to confirm" or "shall I proceed?"). As soon as you know what to do, call the tool so the card appears; the user confirms by clicking Approve.
- Disambiguation happens at most once. When a tool reports multiple matches, present them to the user as a NUMBERED list exactly like "1. ...", "2. ...", and ask them to "reply with the number". Do not list the internal ids. When the user replies with a number (or otherwise names one), immediately call the tool again for that specific record — do NOT ask another clarifying or confirmation question. Never re-ask something the user already answered.
- Changing a contact's lead status is a CONTACT action — use update_lead_status, not notes and not deals. Do not offer a deal as an option for a lead-status change.
- To add someone to HubSpot, default to add_contact (contact + optional company, no deal). Use add_prospect only when the user names a *new person* to add as a prospect (e.g. "add Jane Doe as a prospect"). Never use add_prospect to put an existing company into the pipeline.
- CRITICAL routing for deals:
  • "move Acme to deals", "add Acme to deals/pipeline", "create a deal for Acme", "new deal for Acme", or follow-ups like "new deal" / "create a new one" after talking about a company → call create_company_deal immediately. Do NOT call move_deal_stage. Do NOT call get_company_status first unless the user asked for status. Do NOT ask for deal name, contacts, first name, or email — deal name is always "[Company] - FlairX", all company contacts are auto-associated.
  • create_company_deal flow (strict):
    1. If multiple pipelines: ask "What pipeline?" with Sales / Partnerships only — wait for one answer.
    2. Sales: ask deal stage only (HubSpot dealstage). NEVER ask company lifecycle. NEVER ask relationship_type / referral_status.
    3. Partnerships: ask deal stage only first (that pipeline's stages), then ask relationship type (HubSpot company property relationship_type). NEVER ask company lifecycle.
    When they reply with a number/name, call create_company_deal again using company_id / pipeline_id / stage / relationship_type from the prior [pick posted] message in this thread (it includes an ids map) — do not re-ask the same question.
  • move_deal_stage is ONLY for changing an *existing* deal's pipeline stage (e.g. "move the Acme deal to Negotiation"). It is NOT for creating deals or "moving a company to deals".
- Never create duplicates. Before creating, tools check HubSpot: if a contact (email/name), company (exact name), or deal (company already has deals) already exists, tell the user about the existing record(s) with links — do not post a create card. Only create another deal when the user explicitly asks and you call create_company_deal with force=true. Existing companies are reused (not recreated) when adding contacts.
- When the user asks to create deals for multiple companies in one message, call create_company_deal once per company and report each result. Ask for deal stage (and relationship type on Partnership) once, then reuse those choices for every company. If a tool returns "Error: …", quote that error to the user — do not invent causes like permissions.
- The conversation may span several Slack messages in a thread. Follow-ups in the same thread (without another @mention) continue this conversation. Use the prior turns as context: if you asked a clarifying question and the user answers ("yes", "the first one", "new deal", "let's create a new one", "1", "1 3", etc.), immediately call the correct tool with the company from earlier context — do not ask for contact details. Never reply with a generic greeting mid-conversation.
- When you post a card (e.g. company status), keep your text reply short since the card carries the detail.
- To move a deal "forward" or to the "next" stage, first call get_pipeline_stages and get the current stage (via get_company_status or search_records), then pass the exact next stage label.
- To draft a context-aware follow-up to an unanswered email, use list_unanswered_emails, then get_email_thread, then draft_custom_email with a body referencing that thread.
- Stay within GTM scope.`;

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
• Create a company deal — _"create a deal for Payoneer"_ → pipeline → deal stage (Sales) or deal stage + relationship type (Partnerships)
• Add a note — _"add a note to Acme Corp — demoed today, wants pricing"_ (also refreshes last-activity date)
• Change lead status — _"set Navin Chugh's lead status to Connected"_
• Move a deal stage — _"move the Acme deal to Negotiation"_

*Reminders*
• Follow-up reminder — _"remind me to follow up with Acme in 2 days"_ (creates a HubSpot task + a scheduled Slack nudge)

*Cleanup*
• Marketing junk — type _cleanup_ (or _"clean up marketing emails"_) to scan Conversations auto-creates / spam contacts + orphan companies, then Approve to archive

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

function isCleanupRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[?!.]+$/, "");
  return (
    normalized === "cleanup" ||
    normalized === "clean up" ||
    normalized === "cleanup marketing" ||
    normalized === "clean up marketing" ||
    normalized === "cleanup marketing emails" ||
    normalized === "clean up marketing emails" ||
    normalized === "delete marketing contacts" ||
    normalized === "delete spam contacts"
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
  const trimmed = text.trim();
  // Numbered picks ("1", "2", "1 3") must use the full model + tools.
  if (/^\d+(\s+\d+)?$/.test(trimmed)) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= TRIVIAL_REPLY_MAX_WORDS;
}

function extractPickUserText(toolResult: string): string | null {
  const start = toolResult.indexOf("<<<PICK_USER>>>");
  const end = toolResult.indexOf("<<<END_PICK_USER>>>");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return toolResult
    .slice(start + "<<<PICK_USER>>>".length, end)
    .replace(/^\n/, "")
    .replace(/\n$/, "")
    .trim();
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

    // Fast-path: "cleanup" scans marketing junk and posts an approval card.
    if (isCleanupRequest(userMessage)) {
      const working = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "⏳ Scanning HubSpot for marketing junk…",
      });
      try {
        const result = await runCleanupMarketing({
          client,
          channel,
          threadTs,
          userId,
        });
        const text =
          result.startsWith("[card ready]")
            ? "Review the card above — Approve or Discard."
            : result;
        await client.chat.update({ channel, ts: working.ts!, text });
      } catch (error) {
        console.error("[cleanup] failed:", error);
        const message =
          error instanceof Error ? error.message : "Cleanup scan failed.";
        await client.chat.update({
          channel,
          ts: working.ts!,
          text: message.length > 280 ? `${message.slice(0, 277)}…` : message,
        });
      }
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
    let historyReply = "";

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const completion = await openai!.chat.completions.create({
        model,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
      });

      const choice = completion.choices[0]?.message;
      if (!choice) {
        reply = "Something went wrong — try again.";
        break;
      }

      messages.push(choice);

      if (choice.tool_calls && choice.tool_calls.length > 0) {
        let pickResult = "";
        let cardReady = false;
        let hardError = "";
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
          if (result.startsWith("[pick posted]")) {
            pickResult = result;
          }
          if (result.startsWith("[card ready]")) {
            cardReady = true;
          }
          if (result.startsWith("Error:")) {
            hardError = result.replace(/^Error:\s*/, "");
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
        // Don't let the model invent/restate after picks, cards, or hard errors.
        if (hardError) {
          reply =
            hardError.length > 280 ? `${hardError.slice(0, 277)}…` : hardError;
          break;
        }
        if (pickResult) {
          // Slack gets the clean list once; history keeps ids so the next "2" works.
          reply = extractPickUserText(pickResult) ?? "Reply with a number.";
          historyReply = pickResult;
          break;
        }
        if (cardReady) {
          reply = "Review the card above — Approve or Discard.";
          break;
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
      reply = "Too many steps — narrow the request.";
    }

    // Persist only plain user/assistant turns so trimming can't orphan a
    // tool message (which would break the next OpenAI request).
    // For picks, store the full pick payload (with ids) so the next number works.
    history.push({
      role: "assistant",
      content: historyReply || reply,
    });
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - MAX_HISTORY_MESSAGES);
    }
    conversations.set(conversationKey, history);

    await finish(reply);
  } catch (error) {
    console.error("[agent] turn failed:", error);
    try {
      await finish("Error — try again.");
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
    await post("Image scanning needs OpenAI configured.");
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
      await finish("Couldn't download those images.");
      return;
    }

    const leads = await extractLeadsFromImages(openai, dataUrls, context);
    if (leads.length === 0) {
      await finish(
        "Couldn't read contact details — try a clearer photo or type the info.",
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
        ? "Review the card above — Approve or Discard."
        : `Review the ${leads.length} cards above — Approve or Discard.`,
    );
  } catch (error) {
    console.error("[image-capture] failed:", error);
    try {
      if (workingTs) {
        await client.chat.update({
          channel,
          ts: workingTs,
          text: "Error reading images — try again.",
        });
      } else {
        await post("Error reading images — try again.");
      }
    } catch {
      await post("Error reading images — try again.");
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
