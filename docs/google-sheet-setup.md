# Google Sheet Setup — Prudentia Demo Client Register

Required by W1 (Client Intake) to log new clients. W2 uses hardcoded demo data and does NOT need this sheet.

---

## Step 1 — Create the Sheet

1. Go to [sheets.new](https://sheets.new) in your browser
2. Rename it: `Prudentia Demo - SME Client Register`
3. Add these exact column headers in **Row 1** (no spaces, no capitals changes):

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| `client_name` | `email` | `service` | `phone` | `intake_date` | `docs_received` | `last_reminder` |

4. Get the Sheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit
   ```
   Copy the string between `/d/` and `/edit` — that's your `SHEET_ID`.

---

## Step 2 — Wire Google Sheets credential in n8n

The W1 workflow uses a **Google Service Account** (same pattern as n8n upgrade session — `.local` domain blocks OAuth2).

### In n8n UI:
1. Settings → Credentials → `Prudentia Google Sheets` (already exists if created in previous session)
2. If not: New → Google Sheets (Service Account) → upload your JSON key file
3. In Google Sheets: Share the spreadsheet with the service account email → Editor access

---

## Step 3 — Update W1 workflow with real Sheet ID

After importing `w1-client-intake.json` into n8n:

1. Open the workflow
2. Click the **"Append to Client Register"** node (Google Sheets)
3. In the **Document ID** field: replace `SHEET_ID_PLACEHOLDER` with your real Sheet ID
4. In the credential field: select `Prudentia Google Sheets`
5. Save the workflow

Or patch the JSON before importing (replace the placeholder):

```bash
# Run from repo root — replace YOUR_SHEET_ID with the real ID
SHEET_ID="YOUR_SHEET_ID"
sed -i.bak "s/SHEET_ID_PLACEHOLDER/${SHEET_ID}/g" \
  demos/sme-professional-services/w1-client-intake.json

echo "Patched. Verify:"
grep -A2 '"value":' demos/sme-professional-services/w1-client-intake.json | grep -v PLACEHOLDER | head -5
```

---

## Step 4 — Verify Sheet after W1 test

Run the E2E test:
```bash
./scripts/e2e-test.sh w1
```

Then check the sheet — you should see a new row:

| client_name | email | service | phone | intake_date | docs_received | last_reminder |
|---|---|---|---|---|---|---|
| Nomvula Dlamini | ltmaseko7@gmail.com | Monthly Bookkeeping | +27 82 000 0001 | 2026-04-17 | FALSE | |

---

## Demo note

For the Loom recording: keep the Sheet open in a split screen. Trigger W1 → switch to Sheet → audience sees the row appear live. Strong visual proof of automation.
