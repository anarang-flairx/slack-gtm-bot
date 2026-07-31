# FlairX GTM Bot

Slack bot for FlairX's go-to-market team. **Mention the bot in plain English** — it figures out the action, does the work, and replies in-thread with links to created records.

`@mention` is the only interface (no slash commands). It tracks follow-ups, drafts Gmail emails, moves deals, adds prospects, and answers pipeline questions — all in natural language, with an Approve/Discard card before anything is written.

## Problem

FlairX's GTM motion is conference-heavy and high-touch. Three bottlenecks slow it down:

1. **Manual lead capture** — badge photos become evening spreadsheet work before anything reaches HubSpot.
2. **Follow-ups fall through** — commitments made on WhatsApp, LinkedIn, or email rely on memory.
3. **Disconnected data** — Apollo (outbound) and HubSpot (pipeline) exist, but the team lives in Slack.

FlairX GTM Bot connects field activity, deal follow-ups, and pipeline data into Slack — where the team already works.

## How it works

Mention the bot and ask for what you want. The bot runs an OpenAI tool-calling loop (`gpt-4.1` by default) that maps your request to the right HubSpot/Gmail action. Anything that writes data first posts an **Approve / Discard** card; nothing is created, moved, or drafted until you approve. Only the person who made the request can approve their own card.

## What you can ask

| Ask | What happens |
|---|---|
| "what are the sales pipeline stages?" / "what lead statuses do we have?" | Answers from HubSpot |
| "what's the status of Acme Corp?" | Posts a company card: deals, contacts, notes (incl. Codex-written HubSpot notes), last activity |
| "add a note to Acme Corp — demoed today, sending proposal" | Preview → appends a dated note + refreshes the activity date (contact, company, or deal) |
| "move Acme Corp to Negotiation" | Preview → updates the deal stage and logs a dated note |
| "add Jane Doe at Acme, jane@acme.com, VP Talent, met at SHRM 2026" | Preview → creates a contact (+ company) and a deal in **Prospecting** |
| "draft an intro email to Jane Doe" / "…event follow-up…" | Preview → templated draft saved to Gmail Drafts |
| "who hasn't replied to my emails this week?" | Lists sent Gmail threads with no reply, then can draft context-aware follow-ups |
| "summarize the Acme email thread into their notes" | Reads the thread, previews a summary note on the contact **and** its company |
| "post the digest" | Builds and posts the daily digest to `DIGEST_CHANNEL` |

Example:

```text
@FlairX GTM Bot add a note to Acme Corp — called today, demo booked for next week
@FlairX GTM Bot move Acme Corp forward to Demo Scheduled
@FlairX GTM Bot who hasn't replied to my emails in the last 10 days?
```

When a name is ambiguous, the bot lists the matches and asks which one you mean.

### Notes and activity dates

Bot-written notes use custom HubSpot properties (contact `outreach_notes` / `last_contact_date`, deal `deal_notes` / `notes_last_updated`, company `company_notes` / `notes_last_updated`) and set the activity date. The bot **also reads native HubSpot note engagements** — the notes the CEO writes from Codex via the HubSpot MCP connection — so the company status card and the digest's stalled/follow-up checks reflect that activity too.

### Daily digest

- Pipeline snapshot (open deals, raw + weighted totals)
- Stalled deals by stage quiet thresholds
- Contacts owed a follow-up (Attempted / Connected) with **Draft follow-up** buttons
- Overdue HubSpot tasks (when present)

Setup: invite the bot to your digest channel, put its channel ID in `.env` as `DIGEST_CHANNEL`, set `HUBSPOT_PORTAL_ID` / `HUBSPOT_APP_HOST` for record links, then ask `@FlairX GTM Bot post the digest`.

### Email drafting

- Templated (intro / event follow-up) or custom, context-aware drafts
- Approve → saved to Gmail Drafts
- **The bot never sends email** — a human always presses send

## Relationship to the CEO's Codex setup

The CEO also has Codex connected to HubSpot (MCP) and Gmail, which covers the same use cases for personal, ad-hoc work in a private chat. This Slack bot is the **team-visible** layer: shared Approve/Discard cards, in-channel status, and the digest. Because the bot reads native HubSpot notes, both surfaces stay consistent.

## Non-goals

- Does not send email autonomously (Gmail drafts only)
- Does not replace HubSpot as the system of record
- No direct WhatsApp/LinkedIn API in v1 (forward-to-Slack instead)
- GTM scope only — not a general-purpose assistant

## Tech stack

- **Slack** — [Bolt for JavaScript](https://slack.dev/bolt-js/), Socket Mode (no public webhook in v1)
- **LLM** — OpenAI tool calling (`gpt-4.1`, overridable via `OPENAI_MODEL`)
- **Integrations** — HubSpot (Service Key), Gmail (compose + read-only OAuth)
- **Runtime** — Node.js + TypeScript

## Getting started

### Prerequisites

- Node.js 18+
- A Slack app with Socket Mode enabled
- OpenAI API key (optional for initial Slack connectivity testing)

### Slack app setup

1. Create an app at [api.slack.com](https://api.slack.com/apps)
2. Enable **Socket Mode** and create an app-level token (`connections:write`)
3. Add bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
4. Subscribe to bot event: `app_mention`
5. Install to workspace

No slash commands are needed. If you're upgrading from an older version, **delete the old slash commands** (`/intro-draft`, `/event-follow-up`, `/update-notes`, `/digest`, `/current-status`, `/add-prospect`) in the Slack app settings so they don't show `dispatch_failed` — everything now runs through `@mention`.

### Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Fill in `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Test Slack without OpenAI
DEV_ECHO_MODE=true

# Required when DEV_ECHO_MODE is false
OPENAI_API_KEY=sk-...
# Optional: override the model (default gpt-4.1)
OPENAI_MODEL=gpt-4.1
```

Invite the bot to a channel and mention it:

```text
/invite @FlairX GTM Bot
@FlairX GTM Bot what are our pipeline stages?
```

With `DEV_ECHO_MODE=true`, the bot replies `Echo: <your text>`. With echo mode off, it runs the full tool-calling agent via OpenAI.

### Gmail setup

The bot needs its own Google OAuth credentials (the Codex Gmail connector only works inside Codex, not here). Run the one-time auth flow to grant **compose + read-only** Gmail access:

```bash
npm run gmail-auth
```

Sign in as the sending account, then copy `GOOGLE_REFRESH_TOKEN` and `GMAIL_SENDER_EMAIL` into `.env`. Read access powers "who hasn't replied?" and email summaries; compose access powers Gmail drafts. If you authorized an earlier version (compose only), re-run this to add the read scope.

### HubSpot setup

Complete the one-time HubSpot checklist: [HUBSPOT_SETUP.md](HUBSPOT_SETUP.md)

Deal pipeline stages (must match exactly):

1. Prospecting
2. Initial Contact
3. Demo Scheduled
4. Demo Completed
5. Proposal Sent
6. Negotiation
7. Closed Won
8. Closed Lost

## Project structure

```text
slack-gtm-bot/
├── src/
│   ├── index.ts          # Entry point: registers the mention agent + button handlers
│   ├── agent/tools.ts    # OpenAI tool schemas + executor (wraps HubSpot/Gmail)
│   ├── handlers/         # mention loop + Approve/Discard action handlers
│   ├── integrations/     # hubspot.ts, gmail.ts
│   ├── lib/              # previews (Block Kit), stores, note/draft helpers
│   └── digest/           # daily digest queries + blocks
├── PRD.md                # Full product requirements
├── HUBSPOT_SETUP.md      # HubSpot one-time setup checklist
├── .env.example
└── package.json
```

See [PRD.md](PRD.md) for full requirements, architecture, data model, and success metrics.

## Slack channels

| Channel | Purpose |
|---|---|
| `#gtm-leads` | Badge scans and lead capture |
| `#gtm-pipeline` | Daily/weekly pipeline reports |
| CEO DM | Digest, nudges, email drafts |
| Any invited channel | Pipeline Q&A |

## License

Private — internal FlairX use only.
