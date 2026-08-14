# PRD: FlairX GTM Slack Bot ("Flare")

| | |
|---|---|
| **Document status** | v1.1 — partially shipped |
| **Author** | GTM Team (Aayush Narang) |
| **Last updated** | August 14, 2026 |
| **Audience** | Sections 1–5: exec / GTM team. Sections 6–9: engineering. |

> **Sections 1–9 are the original product vision.** Parts of it shipped, parts changed shape during the build, and some features were never built (Apollo enrichment, slash commands, WhatsApp/LinkedIn commitment capture).
>
> **For what the bot actually does today, read [Section 10](#10-as-built-functionality-current-implementation).** Where 1–9 and 10 disagree, Section 10 is the truth. [Section 11](#11-hubspot-setup-checklist-one-time) is the one-time HubSpot setup.

---

## 1. Overview and Problem Statement

FlairX is an AI interview platform that conducts and scores candidate interviews end-to-end, helping recruiting teams cut time-to-hire. The GTM motion today is high-touch and conference-heavy, and three problems are slowing it down:

1. **Manual lead capture at conferences.** A GTM team member photographs a prospect's badge, then later manually transcribes name, email, company, employee count, open roles, etc. into a spreadsheet before it ever reaches a system of record. This is slow (often next-day), error-prone, and leads go cold before first contact.
2. **Follow-ups fall through the cracks.** The CEO owns most deal follow-ups, but her schedule means commitments made over email, WhatsApp, or LinkedIn ("let's talk in two weeks") are frequently forgotten. There is no system that reminds her — the reminder *is* her memory.
3. **Outbound and pipeline data are disconnected.** Apollo (outbound) and HubSpot (pipeline) exist, but nothing connects field-captured leads, messaging-app commitments, and deal-stage history into one place the team actually looks at: Slack.

**The solution** is a Slack bot — working name **Flare** — that lives in the FlairX Slack workspace and:

- Turns a badge photo into an enriched HubSpot contact + company + deal in under a minute.
- Sends the CEO a daily digest of deals needing attention, plus targeted nudges for specific commitments.
- Captures meeting commitments made on WhatsApp/LinkedIn via a simple forward-to-Slack flow.
- Drafts stage-aware follow-up emails and places approved drafts directly into the CEO's Gmail Drafts (the bot never sends).
- Answers natural-language pipeline questions and posts recurring pipeline summaries.

The interaction model follows the pattern the team already uses successfully with the FlairXSupport bug-ticketing bot (mention the bot, it does the work, it replies in-thread with a link to the created record).

### How this supports current GTM goals

| GTM goal | How Flare helps |
|---|---|
| Pipeline diagnosis (Session 1) | Stage-by-stage HubSpot data, surfaced in Slack, shows exactly where the funnel breaks — no leads, no conversion, or no closing |
| Customer review | Revenue, acquisition source, and sales-cycle length pulled directly from HubSpot deal records, not memory |
| ICP draft (Session 2) | Built from real win patterns in HubSpot data (industry, size, ATS in use), which Flare keeps complete via enrichment |
| Lead-gen experiments | Apollo runs outbound tests; HubSpot (fed by Flare) tracks which channels convert to revenue |
| Follow-up discipline | Flare reads deal stage from HubSpot to draft follow-ups, send reminders, and report daily updates |

---

## 2. Users and Personas

### P1 — GTM team member ("the field")
Attends conferences, collects badges/business cards, owns top-of-funnel. Needs lead capture to take seconds, not an evening of spreadsheet work. Primary user of **badge scan** and **pipeline Q&A**.

### P2 — CEO ("the closer")
Owns mid- and late-stage deals and all executive follow-ups. Extremely time-constrained; communicates with prospects across email, WhatsApp, and LinkedIn. Needs the bot to *remember for her* and to remove friction from writing follow-ups. Primary user of **reminders**, **commitment capture**, and **email drafting**.

### P3 — Broader team ("the audience")
Everyone else in the Slack workspace who benefits from ambient pipeline visibility: recurring summaries in a shared channel, and the ability to ask the bot questions without opening HubSpot.

---

## 3. Core Features

### 3.1 Badge Scan → HubSpot Lead

**User story:** *As a GTM team member at a conference, I want to photograph a badge and have a complete, enriched lead appear in HubSpot, so I never spend an evening transcribing spreadsheets again.*

**Flow:**

1. User posts a badge (or business card) photo in the `#gtm-leads` channel, optionally with context text: `@Flare met at SHRM 2026, hiring 20 engineers, wants demo`.
2. Flare runs LLM-vision extraction on the photo: full name, job title, company name, email (if printed), location.
3. Flare enriches via Apollo (People Match / waterfall enrichment): verified email, company size, industry vertical, growth stage/funding, hiring signals (open roles), technographics (current ATS/hiring tools).
4. Flare posts an **editable confirmation card** in-thread showing all extracted + enriched fields, with `Approve`, `Edit`, and `Discard` buttons. Any field can be corrected inline before approval.
5. On `Approve`, Flare:
   - Creates (or dedupes against) the HubSpot **contact**, **company**, and a **deal** in the **Prospecting** stage.
   - Sets `Lead source = <conference name>` (parsed from the message or prompted).
   - Logs the badge photo and context note on the contact timeline.
   - Replies in-thread with links to the created records — same UX as the JIRA bug bot.

**Example interaction:**

> **Aayush** *(posts photo)*: `@Flare met at SHRM 2026, hiring ~20 engineers, wants a demo in July`
>
> **Flare**: Here's what I found — please confirm:
> • **Jane Doe** — VP Talent Acquisition, **Acme Corp**
> • jane.doe@acme.com (verified via Apollo) · Acme: 850 employees, SaaS, Series C
> • Current ATS: Greenhouse · 23 open roles
> • Lead source: SHRM 2026 · Note: "hiring ~20 engineers, wants a demo in July"
> `[Approve]` `[Edit]` `[Discard]`
>
> **Aayush**: *(clicks Approve)*
>
> **Flare**: Created in HubSpot: [Contact: Jane Doe] · [Company: Acme Corp] · [Deal: Acme Corp — SHRM 2026 (Prospecting)]. I'll include this deal in follow-up tracking.

**Edge cases:**
- Photo unreadable / partial → Flare posts what it could extract and asks for the missing fields in-thread.
- Contact already exists in HubSpot → Flare flags the duplicate, shows the existing record, and offers `Update existing` / `Create new deal on existing contact`.
- Apollo has no match → lead is created from OCR data alone, flagged `enrichment: none` for later manual review.
- Multiple badges in one photo → Flare posts one confirmation card per person detected.
- Batch mode: multiple photos in one message are processed as a queue with one card each.

#### 3.1.1 Implementation on the current bot (no-Apollo path)

The bot today is mention-driven and gates every write behind an Approve/Discard card (the same pattern used for `add_prospect`, note updates, and reminders). Badge scan slots into that architecture without Apollo:

**What it will be able to do:**

1. **Intake** — the user `@`-mentions the bot in a channel and attaches one or more badge/business-card photos, optionally with context: `@Flare met these at SaaStr 2026, all want demos`. The bot reads `event.files` (today it only reads `event.text`, so this is the core new work) and keeps only image files.
2. **Download** — each image is fetched from Slack's `url_private` using the bot token. Requires the **`files:read`** scope (Slack app reinstall).
3. **Vision OCR** — images are sent to the vision-capable model (`gpt-4.1`) with a structured JSON schema requesting: full name, job title, company, email, phone, location, plus a per-field confidence. **Multiple people in a single photo** are returned as separate entries.
4. **Per-badge preview** — for each detected person the bot reuses the `add_prospect` flow and posts one **Approve/Discard card**, pre-filled with the OCR'd fields, the **lead source** (conference name parsed from the message), and the context note. Low-confidence or missing fields (e.g. no printed email) are flagged on the card for the user to fill in.
5. **On approve (full prospect)** — creates **contact + company + a deal in the Prospecting stage** (deduping against existing records), stamps lead source, logs the context note, and replies with links to the created records.

**Deltas from the full 3.1 vision:** no Apollo enrichment in this path, so fields are limited to what's printed on the badge plus what the user adds — company size, industry, ATS, and verified/waterfalled email are **not** auto-filled yet. Apollo enrichment (step 3 of the full flow) remains a later add that plugs in between OCR and the preview card. Everything else — dedupe, one-card-per-badge, batch queue, record links — is achievable on the current stack.

**New pieces required:** `files:read` scope; file-download + base64 helper; a `scan_badges` path in the mention handler (image branch); a vision extraction call with a JSON schema; and reuse of the existing prospect store + preview card, one per detected person.

#### 3.1.2 Build vs. buy — HubSpot mobile business-card scanner

HubSpot's mobile app includes a built-in business-card scanner that OCRs a card and creates a contact. It's worth weighing against the bot path:

| Dimension | HubSpot mobile scanner | Flare badge scan (this bot) |
|---|---|---|
| Build effort | Zero — already exists | Requires the work in 3.1.1 |
| What it creates | **Contact only** | **Full prospect: contact + company + deal (Prospecting)** |
| Lead source / context note | Manual afterward | Parsed from the Slack message, set on approve |
| Multiple badges in one photo | No (one card at a time) | Yes (one preview card each) |
| Batch capture | One at a time in the app | Drop many photos in one Slack message |
| Where you do it | On the phone, in the moment | Anytime, from Slack (desktop or mobile) |
| Team visibility / approval | Private to the scanning user | Team-visible card with Approve/Discard |
| Dedupe against your pipeline | Basic | Tuned to your objects/associations |
| Enrichment | None (native) | None today; Apollo is a planned add |

**Recommendation:** the HubSpot scanner is a perfectly good **zero-effort stopgap** for solo, contact-only capture and as an **offline fallback** at a booth with no signal. But it stops at a contact — it won't create the company, the Prospecting deal, the lead source, or the context note, and it isn't team-visible. Since the stated need is **full prospect** creation with review, the Slack-bot path (3.1.1) is the better primary flow, with the HubSpot scanner kept as a manual fallback. The two can coexist.

### 3.2 Follow-up Reminders and Daily Digest

**User story:** *As the CEO, I want a daily summary of deals needing my attention and targeted nudges for specific commitments, so nothing falls through the cracks even when my calendar is full.*

**Daily digest (DM to CEO, default 8:00 AM local):**

- **Overdue follow-ups** — deals whose next-step task date has passed.
- **Stale deals** — no logged activity beyond a per-stage threshold (defaults: Prospecting 7d, Initial Contact 5d, Demonstration 3d, Proposal Sent 3d, Negotiation 2d; configurable).
- **Closing soon** — deals with a close date within 7 days.
- **Commitments due** — nudges from WhatsApp/LinkedIn/email commitments (see 3.3).

Each digest line has action buttons: `[Draft email]` `[Snooze 1d/3d/1w]` `[Mark done]` `[Open in HubSpot]`.

**On-demand commands:**

| Command | Result |
|---|---|
| `/leads due` | Everything overdue or due today, most urgent first |
| `/leads stale [stage]` | Stale deals, optionally filtered to one pipeline stage |
| `/leads digest` | Run the daily digest now |
| `/leads remind <contact> <when> [note]` | Manually schedule a nudge, e.g. `/leads remind Jane Doe in 2 weeks re: demo scheduling` |

**Escalation:** a nudge that is neither actioned nor snoozed re-fires the next day, and after 3 misses is flagged in the digest with an `OVERDUE 3+ days` marker.

**Data source:** all reminder logic reads from HubSpot (deal stage, tasks, last-activity timestamps). Flare never keeps its own parallel copy of deal truth — it only stores scheduling state (what nudge fires when).

### 3.3 WhatsApp / LinkedIn Commitment Capture (Forward-to-Slack)

**User story:** *As the CEO, when a client messages me on WhatsApp or LinkedIn to set up a meeting in two weeks, I want to forward that message to Slack and have the bot remember it for me, so a messaging-app promise carries the same weight as a CRM task.*

**Flow:**

1. CEO forwards the message content into Slack — either paste the text or drop a screenshot — and mentions the bot: `@Flare from WhatsApp:` + screenshot, or `@Flare LinkedIn — Raj from TalentWorks wants to meet in 2 weeks to discuss pilot pricing`.
2. Flare parses it (LLM text parsing; LLM vision for screenshots) and extracts: **who** (contact name/company), **what** (the commitment), **when** (resolves relative dates like "in two weeks" against the message date), and **channel** (WhatsApp/LinkedIn).
3. Flare matches the person against HubSpot contacts (fuzzy name + company match). Ambiguous match → Flare asks: "Did you mean Raj Patel (TalentWorks) or Raj Kumar (TalentHub)?"
4. Flare posts a confirmation card: contact, commitment, due date, associated deal. On approve, it:
   - Logs a **note** on the HubSpot contact/deal timeline ("WhatsApp 7/2: wants meeting ~7/16 re: pilot pricing", screenshot attached).
   - Creates a HubSpot **task** with the due date, assigned to the CEO.
   - Schedules a Slack **nudge**: reminder 2 days before the due date and on the day, with `[Draft email]` / `[Snooze]` / `[Done]` buttons; escalates per 3.2 if ignored.

**Example interaction:**

> **CEO**: `@Flare from WhatsApp:` *(screenshot: "Great meeting you at SHRM! Let's set up a call in two weeks to go over pilot pricing — Raj")*
>
> **Flare**: Got it. Logging this commitment:
> • **Raj Patel** — TalentWorks (matched to HubSpot deal: *TalentWorks — Proposal Sent*)
> • Commitment: call re: pilot pricing · Due: **~July 16** (2 weeks from message)
> • Source: WhatsApp (screenshot attached to HubSpot note)
> `[Confirm]` `[Edit date]` `[Wrong contact]`
>
> **CEO**: *(clicks Confirm)*
>
> **Flare**: Done. Task created in HubSpot, and I'll nudge you on **July 14** and **July 16**.

**Deliberate design choice — no direct WhatsApp/LinkedIn API integration in v1:**
- WhatsApp Business API cannot read a personal WhatsApp inbox; LinkedIn has no official messaging API for this use case, and unofficial access risks account restriction.
- Forward-to-Slack costs nothing, ships in Phase 2, carries zero ToS risk, and the forwarding step doubles as human confirmation of what matters.
- Automatic inbox monitoring via a unified-messaging API (e.g. Unipile, ~$50–100/mo) is documented as a future consideration in Section 9.

### 3.4 Email Drafting (Gmail)

**User story:** *As the CEO, I want the bot to draft a context-aware follow-up and put it in my Gmail Drafts after I approve it, so following up takes one click instead of twenty minutes.*

**Flow:**

1. Triggered from a digest/nudge button (`Draft email`), or on demand: `@Flare draft a follow-up to Jane Doe about scheduling the demo`.
2. Flare pulls context from HubSpot: deal stage, timeline notes (including badge-capture context and messaging commitments), last contact date, contact's preferred communication method.
3. Flare generates a **stage-aware** draft:
   - *Prospecting* → warm intro referencing where you met.
   - *Initial Contact* → value prop + demo ask.
   - *Demonstration* → demo recap + next-step proposal.
   - *Proposal Sent* → gentle nudge referencing the proposal.
   - *Negotiation* → momentum-keeper addressing open items.
4. Draft is posted in Slack with `[Approve → Gmail Drafts]` `[Revise]` (free-text feedback, e.g. "shorter, mention the SHRM keynote") `[Discard]`.
5. On approve, Flare creates the draft in the CEO's **Gmail Drafts** via the Gmail API — recipient, subject, and body pre-filled. **The bot never sends.** The CEO opens Gmail, gives it a final glance, and hits send herself. Flare logs "draft created" on the HubSpot deal timeline.

**Division of labor with Apollo:**
- **1:1 relationship-stage follow-ups** (this feature) → Gmail Drafts, CEO's personal voice and address.
- **Cold bulk outbound** → Apollo sequences, managed in Apollo. Sending sequence emails consumes **no Apollo credits** (email sending is unlimited under fair use, ~500/day/user on Basic); credits are only consumed by data reveals/exports, not sending. Flare can add an approved contact to a named Apollo sequence on request: `@Flare add Jane Doe to the "SHRM follow-up" sequence`.

### 3.5 Pipeline Q&A and Reporting

**User story:** *As anyone on the team, I want to ask pipeline questions in plain English and get recurring summaries in Slack, so HubSpot's data is ambient rather than buried.*

**Natural-language Q&A (mention the bot anywhere it's invited):**
- `@Flare what's in Negotiation right now?`
- `@Flare show me all deals from SHRM 2026`
- `@Flare which deals have been stuck in Proposal Sent the longest?`
- `@Flare what did we close-lose last quarter and why?` (aggregates `loss reason` and `competitor evaluated`)

Flare translates the question into HubSpot CRM Search API queries and answers with a formatted summary plus record links. Questions it cannot map safely get a clarifying question, never a guessed answer.

**Recurring reports (posted to `#gtm-pipeline`):**
- **Daily**: deals moved between stages in the last 24h, new leads created, tasks completed.
- **Weekly**: funnel snapshot — count and value per stage, week-over-week stage-conversion rates, average days-in-stage, win/loss tally with loss reasons. This is the direct input for the Session 1 pipeline diagnosis ("where does the funnel break?") and Session 2 ICP work (win patterns by industry, size, ATS).

---

## 4. Non-Goals

- **Flare never sends email autonomously.** It creates Gmail drafts only; a human always presses send. (Apollo sequences send, but those are configured and owned inside Apollo.) — *Still true as built.*
- **Flare never auto-advances deal stages.** ~~Stage changes are human decisions made in HubSpot; the bot reads stages, it does not write them.~~ — *Changed in build.* The bot **can** move a deal's stage via `move_deal_stage`, but only from an explicit request and only after the requester approves the card. It never advances a stage on its own initiative, which is what this non-goal was protecting. See 10.4.
- **Flare does not replace HubSpot as the system of record.** It stores no CRM data of its own beyond nudge-scheduling state and Slack↔HubSpot ID mappings.
- **No direct WhatsApp/LinkedIn API integration in v1** (see 3.3).
- **No calendar booking.** Flare reminds about meetings; it does not schedule them (a Calendly/Google Calendar integration is a possible future addition).
- **Not a general-purpose assistant.** Scope is GTM: leads, deals, follow-ups, reporting.

---

## 5. Success Metrics

| Metric | Baseline (today) | Target (90 days post-launch) |
|---|---|---|
| Badge → CRM record time | Hours to next-day (manual) | < 2 minutes |
| Conference leads entered into CRM | Partial (spreadsheet attrition) | 100% of scanned badges |
| Follow-up SLA (task done by due date) | Untracked, anecdotally poor | ≥ 80% |
| Messaging commitments tracked in CRM | ~0% | ≥ 90% of forwarded commitments |
| % conference leads reaching Initial Contact within 7 days | Unknown | ≥ 60% |
| CEO time on follow-up admin | Est. 3–5 hrs/week | < 1 hr/week |
| Data completeness on new leads (email, size, industry, ATS) | Sparse | ≥ 85% of fields auto-filled |

Instrumentation: Flare logs every action (scan, approve, nudge fired, nudge actioned, draft created) so these metrics are reportable from the bot's own event log plus HubSpot.

---

## 6. Technical Architecture

### 6.1 Components

- **Slack app** (Bolt for JavaScript/TypeScript or Python, Socket Mode for v1 to avoid public-endpoint setup): Events API subscriptions for `app_mention` and `file_shared`, slash commands (`/leads …`), Block Kit interactive cards (approve/edit/snooze buttons), scheduled DMs.
- **Backend service** (single small Node/Python service, deployable on Render/Railway/Fly): webhook handlers, the reminder scheduler (cron), and integration clients. A lightweight Postgres (or SQLite for v1) stores nudge schedules, Slack↔HubSpot ID mappings, and the event log.
- **LLM layer**: vision model (e.g. GPT-4o or Claude) for badge OCR and screenshot parsing with structured-output JSON schemas; text model for commitment parsing, email drafting, and NL→CRM-query translation.
- **Integration clients**: HubSpot (private app), Apollo (REST API), Gmail (OAuth), Slack (bot token).

### 6.2 Data flows

**Badge scan flow:**

```mermaid
flowchart LR
    subgraph slack [Slack]
        Photo[Badge photo posted in gtm-leads]
        Card[Confirmation card]
        Links[Record links in thread]
    end
    subgraph backend [Flare Backend]
        OCR[LLM vision extraction]
        Enrich[Apollo enrichment]
        Dedupe[HubSpot dedupe check]
        Create[Create contact company deal]
    end
    Photo --> OCR --> Enrich --> Dedupe --> Card
    Card -->|Approve| Create --> Links
    Create --> HubSpot[(HubSpot CRM)]
    Enrich --> Apollo[(Apollo API)]
```

**Reminder / commitment flow:**

```mermaid
flowchart LR
    Fwd[CEO forwards WhatsApp or LinkedIn message] --> Parse[LLM parses who what when]
    Parse --> Match[Match contact in HubSpot]
    Match --> Confirm[Confirmation card in Slack]
    Confirm -->|Approve| Log[Note and task in HubSpot]
    Log --> Sched[(Nudge schedule DB)]
    Cron[Daily scheduler] --> Sched
    Cron --> HS[("HubSpot: stale deals, due tasks, close dates")]
    Cron --> Digest[Daily digest DM to CEO]
    Digest -->|Draft email button| Draft[LLM email draft]
    Draft -->|Approve| Gmail[(Gmail Drafts)]
```

### 6.3 Reminder engine

- Cron job (every 15 min) evaluates: HubSpot tasks due, per-stage staleness thresholds, close dates within window, and locally scheduled nudges.
- Nudges are idempotent (one nudge per deal per rule per day) and stateful (snooze/done/escalation-count stored locally).
- HubSpot is polled rather than webhook-driven in v1 (simpler; Starter API limits make polling every 15 min trivially cheap). Migration to HubSpot webhooks is a later optimization.

### 6.4 Security and privacy

- All tokens (Slack, HubSpot, Apollo, Gmail OAuth refresh token) stored as environment secrets; never in code or Slack.
- Gmail scope restricted to `gmail.compose` — the narrowest scope that supports draft creation; it grants **no inbox read access**. The scope technically permits sending, so the guarantee that the bot never sends is enforced in code: the send endpoint is never called, only `drafts.create`.
- Badge photos and screenshots are transferred to HubSpot attachments and not retained by the backend beyond processing.
- Bot only operates in channels it is explicitly invited to; digest DMs go only to the CEO.
- Event log contains record IDs and actions, not message bodies.

---

## 7. Integrations and Plan Constraints

### 7.1 HubSpot — Sales Hub Starter

- **Auth**: private app access token (no marketplace listing needed).
- **APIs used**: CRM objects (contacts, companies, deals), associations, tasks/notes (engagements), CRM Search, pipelines API (to read the 7 stages: Prospecting → Initial Contact → Demonstration → Proposal Sent → Negotiation → Closed Won / Closed Lost).
- **Rate limits (Starter, private app)**: 100 requests / 10 seconds, 250,000 / day — orders of magnitude above expected usage (a heavy conference day is a few hundred calls).
- **Key constraint**: workflow-triggered Slack actions in HubSpot require Professional tier. This is precisely why Flare is a **custom Slack app talking to the HubSpot API directly** rather than relying on HubSpot's native Slack integration, which on Starter only supports basic notifications and slash-command search.
- **Prerequisite setup (one-time, manual)**: create the custom properties listed in Section 8 and the pipeline before launch. See the step-by-step checklist in [Section 11](#11-hubspot-setup-checklist-one-time).

### 7.2 Apollo — Basic Plan

- **API access**: included on Basic (basic-tier API; advanced endpoints and higher rate limits are on higher tiers). Usage is metered from the same credit pool as the UI.
- **Sequences**: unlimited active sequences on Basic (vs. 2 on Free) — the feature that makes Apollo the right home for bulk outbound.
- **Credit model** (what actually costs credits):
  - Verified email reveal: **1 credit**. Phone reveal: **8 credits** (avoid unless needed).
  - Export credits consumed when syncing enriched contacts out of Apollo (CSV/CRM/API enrichment) — Basic includes ~1,000 export credits/month.
  - **Sending sequence emails costs no credits** — unlimited under fair use (~500 emails/day/user on Basic). This answers the "will outbound eat credits?" question: **no**, only data reveals/enrichment do.
- **Budget estimate**: ~1–2 credits per badge lead (email reveal + export on sync). A 100-badge conference ≈ 100–200 credits — comfortably within the Basic allocation.
- **Native Apollo ↔ HubSpot sync**: enabled on Basic; keeps outbound activity and pipeline data in one place. Flare relies on this for sequence-activity visibility rather than reimplementing it.
- **Fallback**: if an Apollo endpoint proves unavailable at the Basic tier during implementation, enrichment falls back to OCR-only lead creation with an `enrichment: none` flag (see 3.1 edge cases); this is a graceful degradation, not a blocker.

### 7.3 Gmail

- **Auth**: Google Cloud OAuth app; one-time consent by the CEO.
- **Scope**: ~~`gmail.compose` **only** — no inbox read access.~~ — *Changed in build.* The shipped bot uses `gmail.compose` **plus `gmail.readonly`**. Read access was needed for "who hasn't replied?" and email-thread summaries (10.6). The never-sends guarantee is unaffected and still enforced in code: only `drafts.create` is ever called, never `messages.send`.
- **API**: `users.drafts.create` with a MIME message (to, subject, body).
- Google verification note: an internal-use OAuth app for a Workspace domain can remain in "internal" mode, avoiding the public app-verification process.

### 7.4 Slack

- **Bot token scopes**: `app_mentions:read`, `chat:write`, `commands`, `files:read` (badge photos and screenshots), `im:write` (digest DMs), `channels:history` + `groups:history` (read photo-message context in invited channels), `reactions:write` (ack with ✅ like the JIRA bot).
- **Surfaces**: `#gtm-leads` (badge scans), `#gtm-pipeline` (reports), CEO DM (digest, nudges, drafts), any invited channel (Q&A).

### 7.5 WhatsApp / LinkedIn

- **v1: no API integration.** Content enters via Slack forwarding (Section 3.3). The "integration" is LLM parsing of forwarded text/screenshots.
- **Future**: unified-messaging API (e.g. Unipile) for automatic inbox monitoring — see roadmap, Section 9.

---

## 8. Data Model Mapping

How each field gets filled: **[OCR]** = badge photo extraction · **[Apollo]** = enrichment · **[Slack]** = prompted/parsed in Slack · **[Team]** = filled manually in HubSpot later.

### Contact properties

| HubSpot property | Source | Notes |
|---|---|---|
| First / last name | [OCR] | Confirmed on card |
| Email | [OCR] → [Apollo] | Apollo verifies/waterfalls if not printed on badge |
| Job title | [OCR] → [Apollo] | |
| Phone | [Apollo] | Only on request (8 credits) |
| **Role in hiring process** | [Slack] → [Team] | Inferred from title (e.g. "VP Talent Acquisition" → decision maker), confirmable on card |
| **Industry focus** | [Apollo] | From company industry |
| **Hiring urgency** | [Slack] | Parsed from capture note ("hiring 20 engineers" → high), else prompted |
| **Preferred communication method** | [Slack] → [Team] | Set/updated when commitments arrive via a channel (e.g. repeated WhatsApp → WhatsApp) |

### Company properties

| HubSpot property | Source | Notes |
|---|---|---|
| Name / domain | [OCR] → [Apollo] | Domain from Apollo match |
| # employees | [Apollo] | |
| **Current ATS / hiring tools** | [Apollo] → [Team] | Technographics where available; else flagged for discovery call |
| **Industry vertical** | [Apollo] | |
| **Growth stage** | [Apollo] | Funding stage / headcount growth signals |
| **Contract type** | [Team] | Sales-process outcome; not knowable at capture |

### Deal properties

| HubSpot property | Source | Notes |
|---|---|---|
| Deal name | Auto | `<Company> — <Lead source>` |
| Pipeline stage | Auto | Always created in **Prospecting**; humans advance stages |
| **Lead source** | [Slack] | Conference name from capture message, else prompted |
| **Deal value** | [Team] | Estimated after discovery |
| Create date | Auto | |
| Close date | [Team] | |
| **Loss reason** | [Team] | Required by bot prompt when a deal hits Closed Lost (Flare asks in Slack if empty) |
| **Competitor evaluated** | [Team] | Same prompt-on-close behavior |

### Bot-owned data (local DB, not CRM truth)

- Nudge schedule: `{hubspot_task_or_deal_id, fire_at, status: pending/snoozed/done, escalation_count}`
- ID map: `{slack_user_id ↔ hubspot_owner_id}`, `{slack_thread_ts ↔ hubspot_record_ids}`
- Event log: `{timestamp, actor, action, record_ids}` for the Section 5 metrics

---

## 9. Phased Rollout

### Phase 1 — Badge scan → HubSpot (weeks 1–3)
Highest manual-labor savings; useful the very next conference.
- Slack app setup, photo intake, LLM-vision OCR, Apollo enrichment, confirmation card, HubSpot record creation, dedupe.
- One-time HubSpot setup: custom properties (Section 8) + 7-stage pipeline.
- **Exit criteria**: 20 real badges processed end-to-end with ≥ 85% field accuracy after card edits.

### Phase 2 — Reminders, digest, and commitment capture (weeks 3–5)
- Reminder engine, daily digest DM, `/leads` commands, snooze/escalation.
- WhatsApp/LinkedIn forward-to-Slack parsing → HubSpot note + task + scheduled nudge.
- **Exit criteria**: CEO receives daily digest; a forwarded "meeting in two weeks" message produces a correct nudge on the correct date.

### Phase 3 — Email drafting (weeks 5–7)
- Gmail OAuth (compose-only), stage-aware draft generation, revise loop, approve → Gmail Drafts, timeline logging.
- Apollo sequence hand-off command for bulk outbound.
- **Exit criteria**: ≥ 5 real follow-ups sent by CEO from bot-created drafts.

### Phase 4 — Pipeline Q&A and reporting (weeks 7–9)
- NL → CRM Search translation, daily/weekly `#gtm-pipeline` reports, win/loss and funnel-conversion summaries feeding Session 1/2 analyses.
- **Exit criteria**: weekly report replaces manual pipeline-review prep.

### Future considerations (not committed)
- **Automatic WhatsApp/LinkedIn inbox monitoring** via a unified-messaging API (e.g. Unipile, ~$50–100/mo). LinkedIn access is unofficial and carries account-restriction risk — revisit only if forwarding proves too much friction.
- HubSpot webhooks instead of polling; calendar integration for booking (Calendly/Google Calendar); voice-note capture at conferences.

### Open questions and risks

| Risk / question | Mitigation |
|---|---|
| OCR accuracy across badge formats (lanyards, glare, partial shots) | Confirmation-card human review is mandatory in v1; measure edit rate; prompt-tune per conference |
| Apollo Basic API surface may gate specific endpoints | Fallback to OCR-only creation (7.2); verify endpoints in a spike during Phase 1 week 1 |
| Apollo credit budget across the year | ~1–2 credits/lead ≈ thousands of leads/year of headroom; dashboard-monitor monthly |
| HubSpot custom properties/pipeline must exist before launch | One-time setup checklist owned by GTM, done in Phase 1 — see [Section 11](#11-hubspot-setup-checklist-one-time) |
| CEO adoption of the forwarding habit | Make the flow one action (screenshot → Slack DM to Flare); track usage in week 1 of Phase 2 and simplify if unused |
| LLM misreads a commitment date | Dates always shown on the confirmation card with `[Edit date]`; never silently scheduled |

---

## 10. As-built functionality (current implementation)

Everything in this section is shipped and running. Where it contradicts Sections 1–9, this section wins.

### 10.1 Interaction model

**`@mention` is the only interface — there are no slash commands.** The `/leads …` commands in 3.2 were never built, and the earlier slash commands (`/intro-draft`, `/event-follow-up`, `/update-notes`, `/digest`, `/current-status`, `/add-prospect`) were removed. Delete them in the Slack app settings if you're upgrading, or they'll show `dispatch_failed`.

- Mention the bot in plain English; an OpenAI tool-calling loop picks the action.
- **Thread follow-ups need no second mention.** Once the bot has replied in a thread, plain messages there continue the conversation. This requires the `message.channels` / `message.groups` / `message.im` / `message.mpim` subscriptions.
- Conversation history is kept per `channel:thread`, capped at 10 messages, in memory.
- Model: `gpt-4.1` (`OPENAI_MODEL`). Short replies like "yes" or "the first one" route to `gpt-4.1-mini` (`OPENAI_CHEAP_MODEL`) — but bare numbers do not, since those are disambiguation picks that need tools.
- Up to 8 tool iterations per turn; 90s OpenAI timeout (`OPENAI_TIMEOUT_MS`).
- `help` and `cleanup` are deterministic fast paths that skip the model entirely.
- When several records match, the bot posts a numbered list and you reply with the number.

### 10.2 The approval model

**Every write to HubSpot or Gmail posts an Approve/Discard card first.** The bot never completes a write itself, and never claims a record was created — only that a preview is ready.

- Pending approvals live in memory with a **30-minute TTL**, are **owner-only** (only the requester can approve), and hold an **in-flight lock** so a double-click can't double-write.
- Daily-job cards are the one exception: they carry a **12-hour TTL** and **anyone can approve** them, since nobody personally requested them.
- A restart drops all pending approvals.

### 10.3 Reading and answering

| Ask | Tool |
|---|---|
| "what are the sales pipeline stages?" | `get_pipeline_stages` |
| "what lead statuses do we have?" | `get_lead_statuses` |
| "what lifecycle stages do companies have?" | `get_company_lifecycle_stages` |
| "show me all customers" | `list_companies_by_lifecycle_stage` |
| "look up Acme Corp" | `search_records` |
| "what's the status of Acme Corp?" | `get_company_status` — posts a card with deals, contacts, notes, last activity |

The status card and digest read **native HubSpot note engagements** as well as the bot's own custom note properties, so notes the CEO writes from Codex via the HubSpot MCP connection show up too.

### 10.4 Writing to HubSpot

| Action | Tool | Notes |
|---|---|---|
| Add a dated note | `update_notes` | Contact, company, or deal; also refreshes the last-activity date |
| Change lead status | `update_lead_status` | Contact-only action |
| Add a contact | `add_contact` | Contact + optional company, no deal — the default for "add X to HubSpot" |
| Add a full prospect | `add_prospect` | Contact + company + deal in Prospecting; only for a genuinely new person |
| Create a deal on a company | `create_company_deal` | Deal is always named `[Company] - FlairX`; every company contact is auto-associated |
| Move a deal's stage | `move_deal_stage` | Existing deals only; stages are validated against **that deal's own pipeline** |
| Set a follow-up reminder | `schedule_follow_up` | Minutes, hours, or days → HubSpot task + scheduled Slack nudge |

**Deal creation is a deterministic wizard, not a model decision.** `create_company_deal` takes a company name only, then walks pipeline → stage → (Partnerships only) relationship type, then posts the card. The picks are handled in code, outside the model, so it can't invent stages or ids.

**Duplicate protection.** Before creating, the tools check HubSpot for an existing contact (by email or name), company (exact name), or deal (company already has one). A hit reports the existing record with links instead of posting a create card. A second deal requires an explicit `force=true`.

**Sales vs Partnerships** are handled differently throughout: Partnership deals carry a relationship type; sales deals don't, and the bot doesn't ask for a company lifecycle stage when creating one.

### 10.5 Lead capture from photos — shipped without Apollo

Section 3.1.1 is built; the full 3.1 vision (Apollo enrichment) is not.

- Attach badge, business-card, or WhatsApp/LinkedIn screenshot photos to a mention, with optional context ("met at SaaStr, wants a demo").
- Images are downloaded from Slack and run through vision OCR.
- **One approval card per person detected** — several people in one photo produce several cards.
- Defaults to `add_contact`; phrases like "as a prospect" or "with a deal" switch it to `add_prospect`.
- JPEG/PNG/WebP only. HEIC is rejected with a message telling the user to re-export.
- **No Apollo enrichment.** Fields are limited to what's printed plus what the user adds; company size, industry, ATS, and verified email are not auto-filled.

### 10.6 Email

Gmail access is **compose + read-only**. The bot never sends.

| Action | Tool |
|---|---|
| Templated draft (intro / event follow-up) | `draft_email` |
| Custom context-aware draft | `draft_custom_email` |
| Find sent mail with no reply | `list_unanswered_emails` |
| Read a thread | `get_email_thread` |
| Summarize a thread into notes | `summarize_email_to_notes` — writes to the contact **and** its company |

> **Every write in the bot is approval-gated.** An automatic sent-mail→notes logger was built and then **removed unshipped** (it was never enabled and never ran): it wrote LLM summaries of outbound mail into contact, company, and deal notes with no review step and no undo. Summarizing a thread into notes is still available on demand via `summarize_email_to_notes`, behind a card like everything else.

### 10.7 Daily digest

`post_digest`, or "post the digest". Posts to `DIGEST_CHANNEL`.

- Pipeline snapshot: open deals, raw and weighted totals.
- **Deals needing a follow-up**, decided by reading each deal's email chains and notes — not by a quiet-day threshold alone. Each row states *why* it needs attention and carries a **Draft follow-up** button.
- Overdue HubSpot tasks, when present.
- Each section is fetched independently, so one HubSpot failure degrades that section instead of killing the whole post.

### 10.8 Cleanup

Runs daily at `CLEANUP_HOUR` (default 8am `CLEANUP_TZ`), posting to `CLEANUP_CHANNEL` or `DIGEST_CHANNEL`. Two passes, **both approval-gated** — no record is ever archived without a human click.

**Pass 1 — unnamed companies.** Finds companies created in the lookback window with a blank name and no deals, and posts one card per company covering that company *and* every contact on it. Approving archives the group and adds their emails/domain to Never Log.

**Pass 2 — marketing junk.** Scans contacts and companies created in the last `CLEANUP_LOOKBACK_HOURS` (default 24), skipping internal emails and anything with a deal, then classifies in two tiers:

1. **Heuristics** — `noreply`/`newsletter`/`marketing` addresses, auto-creation from HubSpot Conversations with no real activity, or ≥2 marketing keyword hits.
2. **Model** — everything else with logged activity goes to `gpt-4.1-mini` in batches, prompted to flag only newsletters, automated senders, and cold spam.

Records with no logged activity are skipped entirely, and a classification error fails toward *keeping* the record. Flagged contacts that belong to a company you already had are dropped as likely false positives. Survivors get **one card each**, showing the **logged email subject lines** — usually the fastest tell — plus the reason, a summary, and an activity snippet.

Run Pass 2 on demand by typing `cleanup`. Archives are HubSpot archives (recycle bin, restorable ~90 days), not permanent deletes.

### 10.9 Missing-email reminders

When a record is created with no way to email anyone, the bot schedules a HubSpot task plus a Slack nudge (default 24h, `MISSING_EMAIL_REMINDER_HOURS`) to go find an address:

- **Contact** — created with no email.
- **Deal** — no associated contact has an email.
- **Company** — newly created *and* has no domain. Reused companies are left alone.

Set `MISSING_EMAIL_REMINDER=false` to disable. The reminder is fire-and-forget — a failure is logged, never surfaced as a creation failure.

### 10.10 What was not built

| PRD feature | Status |
|---|---|
| Apollo enrichment (3.1 steps 3, 7.2) | **Not built.** No Apollo integration at all — no enrichment, no sequence hand-off. |
| WhatsApp/LinkedIn commitment capture (3.3) | **Partial.** Screenshots are OCR'd into *contacts*; commitment/date parsing into tasks + nudges was not built. |
| `/leads` slash commands (3.2) | **Not built.** Replaced by `@mention`. |
| Snooze / escalation / 3-miss `OVERDUE` marker (3.2) | **Not built.** |
| Recurring daily/weekly `#gtm-pipeline` reports (3.5) | **Not built.** The daily digest covers part of this. |
| Editable confirmation cards (`[Edit]` button) (3.1) | **Not built.** Cards are Approve/Discard; corrections are made by asking again. |
| Prompt for loss reason / competitor on Closed Lost (Section 8) | **Not built.** |
| Postgres/SQLite persistence (6.1) | **Changed.** See 10.11. |

### 10.11 Runtime and storage, as built

- **Node.js + TypeScript**, run directly through `tsx` — there is no build step.
- **Slack Bolt in Socket Mode**; no public webhook.
- Four runtime dependencies: `@slack/bolt`, `openai`, `googleapis`, `dotenv`.
- **No database.** The Postgres/SQLite plan in 6.1 was not built. Pending approvals and conversation history are **in-memory** and lost on restart. Only four things persist, as JSON files:

| File | Holds |
|---|---|
| `data/cleanup-schedule-state.json` | Last date the daily cleanup ran |
| `data/digest-state.json` | Digest state |
| `data/never-log.json` | Emails/domains recorded when a cleanup card is approved (see 10.8) |

- **The scheduler is a 60-second poll, not cron.** It fires when the local hour is at/after `CLEANUP_HOUR` and it hasn't run yet that calendar day, so a bot that was down at 8am still runs when it comes back. The run date is written *before* the scan, so a mid-run crash costs a day rather than double-posting cards.
- **No test suite.** `npx tsc --noEmit` is the only automated check.

---

## 11. HubSpot setup checklist (one-time)

Do this once, manually, in the HubSpot UI before launch. ~30 minutes.

### 11.1 Create a service key

Settings → Integrations → **Service Keys** → **Create service key**, named `Flare GTM Bot`, with these scopes:

- `crm.objects.contacts.read` / `.write`
- `crm.objects.companies.read` / `.write`
- `crm.objects.deals.read` / `.write`
- `crm.schemas.deals.read` (pipelines)
- `crm.objects.owners.read` (optional — may not appear on Service Keys)
- `crm.objects.tasks.read` (digest overdue tasks) and task write (reminders)
- `crm.objects.notes.write` (native notes — this is what updates **Last Activity Date**)

Copy it into `HUBSPOT_ACCESS_TOKEN`. It's used as a Bearer token, same as a legacy private-app token. For record links in the digest and cards, also set:

```bash
HUBSPOT_PORTAL_ID=your-portal-id
HUBSPOT_APP_HOST=app-na2.hubspot.com
```

Find the portal ID in any HubSpot URL (`/contacts/{portalId}/...`).

### 11.2 Configure the sales pipeline

Settings → Objects → Deals → Pipelines. The pipeline Flare uses (default `default`; override with `HUBSPOT_PIPELINE_ID`) needs exactly these stages, in order — **labels must match exactly**, since stages are looked up by label:

1. Prospecting
2. Initial Contact
3. Demo Scheduled
4. Demo Completed
5. Proposal Sent
6. Negotiation
7. Closed Won
8. Closed Lost

### 11.3 Create custom properties

Settings → Data Management → Properties. Internal names must match — the bot writes these exact names. All are overridable via env (see `.env.example`).

**Contact**

| Label | Internal name | Type |
|---|---|---|
| Role in hiring process | `role_in_hiring_process` | Text, or dropdown: Decision maker / Influencer / User / Unknown |
| Industry focus | `industry_focus` | Single-line text |
| Hiring urgency | `hiring_urgency` | Dropdown: high / medium / low |
| Outreach Notes | `outreach_notes` | Multi-line text |
| Last Contact Date | `last_contact_date` | Date |

**Method of Contact already exists — do not create it.** Confirm its internal name (often `method_of_contact`) and set `HUBSPOT_METHOD_OF_CONTACT_PROPERTY`.

**Company**

| Label | Internal name | Type |
|---|---|---|
| Current ATS / hiring tools | `current_ats_hiring_tools` | Single-line text |
| Industry vertical | `industry_vertical` | Single-line text |
| Growth stage | `growth_stage` | Single-line text |
| Contract type | `contract_type` | Dropdown |
| Company Notes | `company_notes` | Multi-line text |
| Last Activity Date | `notes_last_updated` | Date |
| Relationship type | `relationship_type` | Dropdown: Referral, Partner, Investor, Advisor (Partnerships only) |

**Deal**

| Label | Internal name | Type |
|---|---|---|
| Lead source | `lead_source` | Single-line text (conference name) |
| Loss reason | `loss_reason` | Dropdown or text |
| Competitor evaluated | `competitor_evaluated` | Single-line text |
| Deal Notes | `deal_notes` | Multi-line text |
| Last Activity Date | `notes_last_updated` | Date |

### 11.4 Find the pipeline IDs

Needed when you have more than one deal pipeline.

**Ask the bot:** `@FlairX GTM Bot what are the sales pipeline stages?` — the reply includes `(pipeline_id: …)` under each pipeline.

**Or the API:**

```bash
node -e "fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {headers:{Authorization:'Bearer '+process.env.HUBSPOT_ACCESS_TOKEN}}).then(r=>r.json()).then(d=>console.log(d.results.map(p=>({id:p.id,label:p.label,stages:p.stages.map(s=>s.label)}))))" --env-file=.env
```

Then set:

```bash
HUBSPOT_PIPELINE_ID=<sales-pipeline-id>
HUBSPOT_PARTNERSHIP_PIPELINE_ID=<partnerships-pipeline-id>
```

If the bot shows the wrong stages for Partnerships, the wrong pipeline id is selected.

### 11.5 Cleanup and channel setup

Invite the bot to the digest/cleanup channel and set its ID. Cleanup needs the contacts and companies **write** scopes above.

```bash
# Never archive contacts on these domains (defaults to the GMAIL_SENDER_EMAIL domain, or flairx.ai)
INTERNAL_EMAIL_DOMAINS=flairx.ai

DIGEST_CHANNEL=C0123456789
#CLEANUP_CHANNEL=C0123456789
#CLEANUP_ENABLED=false
#CLEANUP_HOUR=8
#CLEANUP_TZ=America/Los_Angeles
#CLEANUP_LOOKBACK_HOURS=24
```

See `.env.example` for the full list, including the note-property overrides and `MISSING_EMAIL_REMINDER*`.
