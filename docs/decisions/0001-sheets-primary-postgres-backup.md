# ADR-0001: Google Sheets is the primary store for new workflows; Postgres is backup

- **Status:** Accepted 2026-09-06. **Implementation deferred:** applies to workflows created after
  this date. The live lead pipeline (`templates/lead-to-client-pipeline`) keeps Postgres primary
  with a Sheets mirror until a separate migration decision.
- **Deciders:** owner.
- **Supersedes:** nothing. The lead pipeline's mirror design (its README, "Sheet mirror (WF-E)")
  stays in force for that pipeline.

## Context

The owner wants every record the automations produce to be visible, shareable and portable
without a database client, and wants one Google account to own that data. An earlier attempt to
make Sheets the *only* store for the lead pipeline was rejected on measured grounds: no atomic
upsert, single-use tokens visible to every collaborator, and formula-executing defaults. Those
measurements are not reasons to avoid Sheets. They are the constraints a Sheets-primary design has
to satisfy, so this record keeps the direction and the constraints together.

## Decision

1. **Primary store: a Google Sheet owned by the sheet-owner account.** The account is held in
   Vault under the key `LEAD_SHEET_OWNER`; its value is never committed. Service accounts cannot
   own Drive files, so the owner account creates the spreadsheet (an OAuth2 credential for that
   account makes creation repeatable) and shares it to the service account the workflows use.
2. **Postgres: backup only.** A scheduled reverse mirror (Sheets to Postgres) plus the existing
   daily dump CronJob. Workflow logic does not read Postgres.
3. **Scope:** append-mostly, single-writer, non-secret records.
4. **Carve-out, pending the owner's decision** (tracked in the pull request that introduces this
   record): atomic single-use state, today the `stage_tokens` burn, stays Postgres-primary until a
   Sheets-safe design is proven. The shipped follow-up workflow documents why URL-borne HMAC tokens
   were rejected: replayable for ever, and leaked through browser history and edge logs. If the
   carve-out is rejected, the burn becomes best-effort and a double-use window of seconds is an
   accepted risk.

## Consequences: the controls every Sheets-primary workflow carries

| Constraint, measured against the deployed Google Sheets node v4.7 | Control |
| --- | --- |
| `appendOrUpdate` is read-modify-write with no compare-and-set; two concurrent executions can compute the same row index and one update is lost | one writer per sheet (`maxConcurrency: 1` on that workflow) or an idempotent key plus a periodic reconcile; never two webhook workflows writing one tab |
| Matching is client-side on one column | the key column is unique and first |
| The range is hardcoded to `A:Z` | at most 26 columns per tab |
| `Get Row(s)` filters after fetching the whole tab | tabs stay small, or are partitioned by month or status |
| `cellFormat` defaults to `USER_ENTERED`: values are coerced and `=` formulas execute | `RAW` on every write **and** a leading-apostrophe escape for values starting with `=`, `+`, `-` or `@`, because `RAW` does not survive CSV export and re-import |
| No field-level access control; any viewer can export the whole sheet | secrets and tokens never enter a sheet |
| Per-user write quota; ten million cells per spreadsheet | bursts are queued rather than retried blindly; tabs are archived yearly |
| Sharing defaults | link-sharing disabled per file; the owner check in the mirror sub-workflow extended to assert no link-sharing permission; quarterly permissions audit |
| The owner account is a single point of failure for every record | hardware-key or TOTP multi-factor authentication, not SMS; recovery address and phone recorded in the runbook |
| **No data-processing agreement exists under a consumer Google account** | accepted risk, recorded here; migration trigger is the first client contract that requires one |
| The service-account key sits in n8n's encrypted credential store | rotate yearly and on any exposure |
| Sheets has no retention mechanism | a scheduled purge implements the retention limit |
| The reverse mirror runs on a schedule | the data-loss window equals the mirror interval; at fifteen minutes, up to fifteen minutes of records sit between a sheet corruption and the last backup |

## Migration triggers

- A client contract requiring a data-processing agreement: that client's records move to a
  Workspace tenant or to Postgres-primary.
- Two concurrent writers, or an atomic-state requirement, in a new workflow: that workflow is
  Postgres-primary with a Sheets mirror, which is the lead-pipeline pattern.

## Related

- `templates/lead-to-client-pipeline/README.md`: the mirror design, the ownership check, and the
  measured PII-containment behaviour in queue mode.
- `docs/n8n-estate-report.md`: the report that introduced this record.
