# FlairX GTM Bot

Slack bot for FlairX's go-to-market team. Mention the bot in Slack — it does the work and replies in-thread with links to created records.

Turns badges into HubSpot leads, tracks follow-ups, captures WhatsApp/LinkedIn msgs, drafts Gmail follow-ups, and answers pipeline questions.

## Problem

FlairX's GTM motion is conference-heavy and high-touch. Three bottlenecks slow it down:

1. **Manual lead capture** — badge photos become evening spreadsheet work before anything reaches HubSpot.
2. **Follow-ups fall through** — commitments made on WhatsApp, LinkedIn, or email rely on memory.
3. **Disconnected data** — Apollo (outbound) and HubSpot (pipeline) exist, but the team lives in Slack.

FlairX GTM Bot connects field activity, deal follow-ups, and pipeline data into Slack — where the team already works.

## Features

| Feature | Description | Status |
|---|---|---|
| **Basic chat** | `@mention` the bot for a conversation in-thread | ✅ Phase 0 |
| **Badge scan → HubSpot** | Photo → OCR → Apollo enrichment → confirmation card → CRM records | 🔜 Phase 1 |
| **Reminders & digest** | Daily CEO digest, stale deals, `/leads` commands | 🔜 Phase 2 |
| **Commitment capture** | Forward WhatsApp/LinkedIn to Slack → HubSpot task + nudge | 🔜 Phase 2 |
| **Email drafting** | Stage-aware drafts → Gmail Drafts (bot never sends) | 🔜 Phase 3 |
| **Pipeline Q&A** | Natural-language HubSpot queries + recurring reports | 🔜 Phase 4 |

### Badge scan flow (Phase 1)

1. Post a badge photo in `#gtm-leads` with context: `@FlairX GTM Bot met at SHRM 2026, hiring 20 engineers`
2. Bot extracts contact details (LLM vision), enriches via Apollo
3. Editable confirmation card with Approve / Edit / Discard
4. On approve → HubSpot contact, company, and deal in **Prospecting**

### Reminders & commitments (Phase 2)

- Daily digest DM (overdue follow-ups, stale deals, closing soon, commitments due)
- Slash commands: `/leads due`, `/leads stale`, `/leads digest`, `/leads remind`
- Forward WhatsApp/LinkedIn messages → parsed commitment → HubSpot note + task + scheduled nudge

### Email drafting (Phase 3)

- Stage-aware follow-up drafts from HubSpot context
- Approve → saved to Gmail Drafts
- **The bot never sends email** — a human always presses send

## Non-goals

- Does not send email autonomously (Gmail drafts only)
- Does not auto-advance deal stages in HubSpot
- Does not replace HubSpot as the system of record
- No direct WhatsApp/LinkedIn API in v1 (forward-to-Slack instead)
- GTM scope only — not a general-purpose assistant

## Tech stack

- **Slack** — [Bolt for JavaScript](https://slack.dev/bolt-js/), Socket Mode (no public webhook in v1)
- **LLM** — OpenAI (chat, vision OCR, commitment parsing, email drafting)
- **Integrations** — HubSpot (Service Key), Apollo, Gmail (compose-only OAuth)
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
```

Invite the bot to a channel and mention it:

```text
/invite @FlairX GTM Bot
@FlairX GTM Bot hello
```

With `DEV_ECHO_MODE=true`, the bot replies `Echo: hello`. With echo mode off, it holds a multi-turn conversation via OpenAI.

### HubSpot setup

Before Phase 1, complete the one-time HubSpot checklist: [HUBSPOT_SETUP.md](HUBSPOT_SETUP.md)

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
│   └── index.ts          # Bot entry point (app_mention handler)
├── PRD.md                # Full product requirements
├── HUBSPOT_SETUP.md      # HubSpot one-time setup checklist
├── .env.example
└── package.json
```

## Roadmap

| Phase | Scope | Target |
|---|---|---|
| **0** | Slack app + basic `@mention` chat | ✅ Current |
| **1** | Badge scan → HubSpot | Weeks 1–3 |
| **2** | Reminders, digest, commitment capture | Weeks 3–5 |
| **3** | Gmail draft generation | Weeks 5–7 |
| **4** | Pipeline Q&A and reporting | Weeks 7–9 |

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
