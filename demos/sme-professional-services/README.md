# Prudentia Digital — SA SME Professional Services Demo

> **Audience:** Accountants, attorneys, HR consultancies, estate agents
> **Host:** `https://n8n.homelab.local` (LAN / Tailscale — presenter-controlled)
> **Mode:** Screen share or Loom recording — no self-serve prospect URL

---

## Pre-Demo Checklist

Before any demo or call, run through this list:

- [ ] Tailscale connected (or on LAN `192.168.0.232`)
- [ ] Browser open at `https://n8n.homelab.local` — basic auth entered
- [ ] All 3 workflows visible under **Workflows → search "Prudentia"**
- [ ] W2 (Document Chase) is **Active** (green toggle)
- [ ] W1 and W3 are **Inactive** (triggered only on demand during demo)
- [ ] SMTP credential `Prudentia SMTP` configured and tested
- [ ] Test email address ready (e.g., your own Gmail) for live demo

---

## Workflows

| Ref | Name | Trigger | Status |
|---|---|---|---|
| W1 | Client Intake & Onboarding | Webhook (POST) | Inactive — trigger manually |
| W2 | Document Chase (POPIA-Aware) | Schedule `0 7 * * *` (09:00 SAST) | Active |
| W3 | Quote Dispatch | Webhook (POST) | Inactive — trigger manually |

---

## Webhook URLs

> **Update these after importing into n8n.** Paths are stable (not UUID-based).

| Workflow | URL |
|---|---|
| W1 Client Intake | `https://n8n.homelab.local/webhook/prudentia-client-intake` |
| W3 Quote Dispatch | `https://n8n.homelab.local/webhook/prudentia-quote` |

---

## Credentials Required

Configure these in n8n **Settings → Credentials** before activating:

| Credential Name | Type | Required By |
|---|---|---|
| `Prudentia SMTP` | SMTP | W1, W2, W3 |
| `Prudentia Google Sheets` | Google Sheets OAuth2 | W1 (optional), W2 (optional — has fallback) |

**SMTP setup:** Use Gmail App Password or a homelab SMTP relay.
**Google Sheets:** W2 uses a hardcoded demo dataset if OAuth is not configured — skip Sheets setup for initial demo.

---

## Import Instructions

1. Open `https://n8n.homelab.local` → log in
2. Go to **Workflows → + Add Workflow → Import from File**
3. Import each JSON in order: `w1-client-intake.json`, `w2-document-chase.json`, `w3-quote-trigger.json`
4. For each workflow: open → assign `Prudentia SMTP` credential to the email nodes → save
5. Activate **W2 only** — leave W1 and W3 inactive

---

## Demo Script

### Opening (30 seconds)
> "I'm going to show you three automations we've built specifically for professional services firms like yours. These run on our automation platform and can be live in your business within a week."

---

### Demo 1 — Client Intake (W1)

**Story:** "Right now, when a new client contacts you, someone manually sends a welcome email, captures their details in a spreadsheet, and creates a follow-up reminder. That's 10–15 minutes per client. This workflow does all of that in under 30 seconds — automatically."

**Live demo:**
```bash
curl -X POST https://n8n.homelab.local/webhook/prudentia-client-intake \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Nomvula Dlamini Attorneys Inc.",
    "email": "YOUR_TEST_EMAIL",
    "service": "Monthly Retainer",
    "phone": "011 555 0123",
    "notes": "Referred by Sipho Khumalo"
  }'
```

**Show:** Switch to email inbox — welcome email arrives within 30 seconds. Show the workflow execution log in n8n.

---

### Demo 2 — Document Chase (W2)

**Story:** "How many hours does your team spend chasing clients for outstanding documents? This workflow runs every morning at 9am, checks who hasn't submitted their documents, and sends a polite POPIA-compliant reminder — automatically. No one on your team has to do anything."

**Live demo:**
- Open W2 in n8n → click **Execute Workflow** (manual trigger)
- Show the execution: 3 demo clients loaded → filter runs → 2 clients need chasing → reminder emails sent
- Show the email in your inbox — branded, POPIA opt-out footer included

---

### Demo 3 — Quote Dispatch (W3)

**Story:** "How long does it take your firm to send a quote after a new enquiry? 30 minutes? An hour? With this workflow, the moment someone requests a quote, it's built, branded, and sent within 60 seconds. You also get an internal alert so you know to follow up in 48 hours."

**Live demo:**
```bash
curl -X POST https://n8n.homelab.local/webhook/prudentia-quote \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Sipho & Partners Accounting",
    "email": "YOUR_TEST_EMAIL",
    "service": "Monthly Workflow Automation Retainer",
    "amount": "R12,500 / month"
  }'
```

**Show:** Switch to email inbox — branded quote email with quote reference, valid-until date, and "Accept & Book a Call" button arrives within 30 seconds.

---

### Close

> "These three workflows eliminate roughly 3–5 hours of admin per week for a typical professional services firm. We can have these live and configured for your business within 5 business days. Our fixed-price starter package is R12,500 — that covers the build, testing, and handover. Would you like to see a proposal?"

---

## Backup

Record a Loom of the full demo run before any live prospect call.
Store the Loom URL here: `[ADD LOOM URL AFTER RECORDING]`

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Webhook returns `404` | Ensure the workflow is saved (not just built) — n8n registers webhooks on save |
| Email not arriving | Check `Prudentia SMTP` credential; verify SMTP port (587) and auth |
| W2 no output | Run manually via n8n UI → check execution log for errors |
| Basic auth prompt | Enter n8n credentials stored in `n8n-basic-auth` secret (ask homelab admin) |
| Google Sheets error in W1 | Disable the `Append to Client Register` node — demo still works without Sheets |
