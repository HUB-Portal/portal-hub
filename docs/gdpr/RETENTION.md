# Retention schedule

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It describes what `server/src/services/retention.ts` and related code do on 5 Oct 2026. Whether these periods are right is a decision for K Line and the controllers. [Square brackets] mark open points.

How it runs: the worker queues a `retention` job at most once every 24 hours (checked hourly; the slot is claimed in the `job_runs` table, so several workers do not run it twice). You can also run `cli retention` by hand. The job never touches the audit log. Every purge, erasure and deletion of a case writes an audit entry without patient data.

## 1. Schedule as implemented

### 1.1 Case data

| Data | Rule | Period |
|---|---|---|
| Case files (all stored chunks), file names, wrapped file keys, nonce prefixes and key ids, patient name (full, first, last), name blind indexes, instructions | Purged when `purge_after` is reached (job `purgeDueCases`) | **Standard cases:** shipping time plus the partner's retention months. `purge_after` is set when the case ships (stage `shipped`, or `delivered` for a case that never shipped through the system). **Direct manufacturing cases:** the time of the successful push to the K Line portal plus the retention months. It is not moved later when the case ships. |
| The same data of cancelled cases | Purged when `cancelled_at` is 30 days old (also `purge_after` = cancel time plus 30 days) | 30 days after cancelling |
| Claim evidence (photos, videos, PDFs of quality claims of the case) | Purged together with the case | As the case |
| Drafts | Deleted with their files (audit `case.deleted`, reason `retention`) | 30 days after the last change |
| Uploads that never finished | Deleted (`deleteAbandonedUploads`) | 2 days without a new chunk |
| Logo files that nobody uses | Deleted | 7 days after upload |

The partner's retention months (`organizations.retention_months`) are between 1 and 180, default 24. K Line staff change them in the console (Partners, settings). A change affects only cases that ship afterwards.

On request a partner administrator (own organisation) or a K Line administrator can erase one case at any time (`POST /api/cases/:id/erase`, step up, audit entry `case.erased`, case event `erased`). It uses the same code as the purge below, and also removes the partner case ID of every case type. Drafts are deleted instead. See `PARTNER_GUIDE.md`.

What a purge does: stored chunks are deleted; in the same transaction the wrapped key, nonce prefix, key id and encrypted file name are cleared, so leftover bytes could never be decrypted; encrypted names and instructions and the blind indexes are cleared; the case gets `purged_at`; a `purged` event and the audit entry `case.purged` are written. Storage objects that cannot be deleted are retried on the next run. Objects that a replacement or rework case still uses are kept until the last user is purged. After that `scrubCase` removes what used to stay behind (section 1.2). Purged cases from before 5 Oct 2026 are scrubbed by the next daily run (marker `cases.scrubbed_at`).

### 1.2 What stays after a case is purged

The non identifying production record stays:

* Case reference (for example `ACME-000412`), status, stage, priority, site, dates, aligner counts, carrier, tracking number, factory case number, the specification version.
* The partner case ID of **standard** cases (the partner's own reference; it can be a folder name, so an erasure on request removes it too). **For direct manufacturing cases the patient ID is removed** at the purge (`cases.partner_case_id` becomes empty; the constraint on `cases` allows that once `purged_at` is set).
* Check results (`checks`) and file measurements (`meta`: sizes, counts, SHA-256). File kind, arch, step and size.
* Case events: their types, times and codes. Hold reasons and stage notes are replaced by `[removed]`; the events `purged` and `erased` carry only counts and fixed words.
* Quality claims of the case: number, status, resolution, dates and the aligners and defect codes of the items. The summary, description, root cause, corrective action, decision note, item notes and the messages written by people are replaced by `[removed]` (the fixed status messages of the system stay). `cases.hold_reason` is replaced too.
* Webhook deliveries: the payload stays for 90 days but `case_id` and `partner_case_id` are removed from the payloads of the case reference. Notification text that quoted the case ID shows the reference instead.
* Material movements and usage records.
* Audit entries about the case (references only).

What does not go: the claim text of cases that were never purged (it is plain text until then, see section 3), copies outside the Hub (the K Line portal for direct cases, files a factory system downloaded, backups), and follow up cases (a replacement or rework case has its own copy of the name and case ID until it is purged or erased itself).

### 1.3 Account and registration data

| Data | Rule | Period |
|---|---|---|
| Sessions | Deleted | 7 days after expiry or revocation |
| One time user tokens (invitations, resets, confirmations) | Deleted | 30 days after expiry |
| Registrations whose email was never confirmed | The whole organisation, user, tokens and draft specification are deleted (audit `signup.expired`) | 7 days after registering |
| Registrations declined by K Line after confirming | Users are disabled at once. The whole organisation and its users are deleted (audit `partner.registration_deleted`) | 30 days after the decision |
| Registrations declined before the email was confirmed | Deleted at once when declined | Immediately |
| Registration attempt counters | Deleted | 2 days |
| Registration email throttle records | Deleted | 1 day |
| Users of approved companies | **Not deleted automatically.** Disabled users stay. | [Define] |
| Registrant data of approved companies (`organizations.signup`: registrant name, email, website, volume) | **Stays on the organisation record** | [Define] |
| Company profile, brands, documents, agreements, specifications, materials, API key and webhook records | **Not deleted automatically** | While the company exists |

### 1.4 Operational records

| Data | Period |
|---|---|
| Notifications | 180 days |
| Factory (MES) event log and CSV import log | 180 days |
| Webhook deliveries and their payloads | 90 days after creation |
| Finished and failed jobs (`done`, `failed`) | 14 days after finishing. The payload of an email job (address, one time link) is wiped as soon as the job finishes, whether it was sent or failed for good, and the retention job wipes any email job payload older than 24 hours whatever its state. Error text holds no address or link. |
| Email notice bookkeeping (15 minute window) | 2 days |
| Google sign in flow records (`oidc_flows`: hashed state and nonce, encrypted PKCE verifier, browser binding hash) | Deleted when used, otherwise expire after 10 minutes and are removed 1 day after expiry |
| Development mailbox (demo mode only) | 14 days |

### 1.5 Audit log

The retention job does not touch it. `cli audit-trim --months N` removes entries older than N months (default `AUDIT_RETENTION_MONTHS`, 36) and moves the chain anchor so verification still passes. **This command is not scheduled**, so without an operator the audit log grows without limit [define the period and schedule it]. Entries contain actor ids, IP addresses, user agents and case references.

### 1.6 Backups, logs and email

The reference deployment (`deploy/hetzner/backup.sh`) keeps encrypted database dumps for **35 days**, locally and on the backup storage box, and deletes older ones. If the encrypted file store is synced as well, files that were deleted or replaced stay in a dated folder for the same 35 days. So a purged case can still exist in a backup for up to 35 days, and this is the time to state in privacy documents [confirm the real schedule]. The web server (Caddy) log keeps paths without query strings, in Docker logs limited to 5 files of 20 MB per container. [Define and record: how long sent email stays at the SMTP provider.]

## 2. Checks for operators

* `cli retention` prints counts of purged cases, drafts, uploads, leftover objects and cleaned records.
* `job_runs` holds the last run of `retention` with its report.
* After the first purge in a test environment, check that a purged case shows no files, no name and no instructions, that the storage prefix is empty and that the partner's access log shows `case.purged`.

## 3. Open points

* Claim text and case event details are now scrubbed with the purge (5 Oct 2026). Decide whether the free text should also be encrypted or shortened while the case lives.
* Decide retention for disabled users, registrant data of approved companies, closed agreements and company documents.
* Decide and schedule audit log trimming, and record the period in the privacy notice.
* On demand erasure exists (5 Oct 2026). Define who at K Line answers a data subject request that arrives at K Line instead of the partner, and how K Line asks the portal and the factory sites to remove their copies [define the process].
* Define backup retention and the effect of a purge on backups.
