# HubSpot one-time setup checklist

Flare requires this setup to exist in HubSpot before launch (PRD sections 7.1 and 8). Everything here is done once, manually, in the HubSpot UI. Estimated time: 30 minutes.

## 1. Create a service key

1. Settings → Integrations → **Service Keys** → **Create service key**.
2. Name it `Flare GTM Bot`.
3. Grant these scopes:
   - `crm.objects.contacts.read` / `crm.objects.contacts.write`
   - `crm.objects.companies.read` / `crm.objects.companies.write`
   - `crm.objects.deals.read` / `crm.objects.deals.write`
   - `crm.schemas.deals.read` (pipelines)
   - `crm.objects.owners.read` (optional — may not appear on Service Keys)
   - `crm.objects.tasks.read` (for `/digest` overdue tasks)
4. Copy the service key into `HUBSPOT_ACCESS_TOKEN` in `.env`.

`HUBSPOT_ACCESS_TOKEN` holds the service key — use it as a Bearer token in API requests, same as a legacy private-app token.

For digest HubSpot record links, also set in `.env`:

```bash
HUBSPOT_PORTAL_ID=your-portal-id
HUBSPOT_APP_HOST=app-na2.hubspot.com
```

Find the portal ID in any HubSpot URL (`/contacts/{portalId}/...`).

## 2. Configure the 8-stage sales pipeline

Settings → Objects → Deals → Pipelines. Ensure the pipeline used by Flare (default: the `default` pipeline; set `HUBSPOT_PIPELINE_ID` otherwise) has exactly these stages, in order:

1. **Prospecting**
2. **Initial Contact**
3. **Demo Scheduled**
4. **Demo Completed**
5. **Proposal Sent**
6. **Negotiation**
7. **Closed Won**
8. **Closed Lost**

Stage labels must match exactly — Flare looks stages up by label (e.g. it creates every badge-scan deal in "Prospecting").

## 3. Create custom properties

Settings → Data Management → Properties. Create each with the internal name shown (Flare writes these exact names).

### Contact properties

Create these if they don't already exist:

| Label | Internal name | Type |
|---|---|---|
| Role in hiring process | `role_in_hiring_process` | Single-line text (or dropdown: Decision maker / Influencer / User / Unknown) |
| Industry focus | `industry_focus` | Single-line text |
| Hiring urgency | `hiring_urgency` | Dropdown: high / medium / low |
| Outreach Notes | `outreach_notes` | Multi-line text |
| Last Contact Date | `last_contact_date` | Date |

**Already exists — do not create:** **Method of Contact**. Flare uses this for preferred communication channel (Email, WhatsApp, LinkedIn, Phone). Confirm its internal name in Settings → Data Management → Properties → Method of Contact (often `method_of_contact`).

### Company properties

| Label | Internal name | Type |
|---|---|---|
| Current ATS / hiring tools | `current_ats_hiring_tools` | Single-line text |
| Industry vertical | `industry_vertical` | Single-line text |
| Growth stage | `growth_stage` | Single-line text |
| Contract type | `contract_type` | Dropdown (set by team during sales process) |
| Company Notes | `company_notes` | Multi-line text |
| Last Activity Date | `notes_last_updated` | Date |

### Deal properties

| Label | Internal name | Type |
|---|---|---|
| Lead source | `lead_source` | Single-line text (conference name) |
| Loss reason | `loss_reason` | Dropdown or single-line text |
| Competitor evaluated | `competitor_evaluated` | Single-line text |
| Deal Notes | `deal_notes` | Multi-line text |
| Last Activity Date | `notes_last_updated` | Date |

`/digest` watches deal `notes_last_updated` for stalled deals and contact `last_contact_date` for follow-ups (including empty dates). `/update-notes` appends to the notes field and sets the matching date to today.

## 4. Verify

Run a quick check from the repo once `.env` is filled in:

```bash
node -e "fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {headers:{Authorization:'Bearer '+process.env.HUBSPOT_ACCESS_TOKEN}}).then(r=>r.json()).then(d=>console.log(d.results.map(p=>({id:p.id,stages:p.stages.map(s=>s.label)}))))" --env-file=.env
```

You should see the 8 stage labels above. If your pipeline isn't the `default` one, set its `id` as `HUBSPOT_PIPELINE_ID`.
