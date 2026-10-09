# Data protection impact assessment (DPIA): Portal Hub

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice. It does not certify compliance with the GDPR or any other law or standard. It describes what the software does on 30 Sep 2026 and proposes a structure for the assessment. Every statement about legal roles, legal bases or risk acceptance needs a decision by the responsible people at K Line Europe GmbH and, where they are controllers, at the partner companies. Text in [square brackets] needs a decision or a confirmation.

Version: draft 0.1, 30 Sep 2026. Related documents: `TOMs.md`, `RECORD_OF_PROCESSING.md`, `RETENTION.md`, `SUBPROCESSORS.md`, `TRANSFERS.md`, `BREACH_RUNBOOK.md`, `PRIVACY_NOTICE_NOTES.md`, `../SECURITY.md`, `../OPEN_DECISIONS.md`.

## 1. Why a DPIA

The Hub processes health related data of patients in bulk: dental 3D models and treatment steps, together with names or identifiers, for many partner companies in several countries. Processing is systematic, sensitive and cross border. A DPIA is appropriate. The partner companies are expected to be the controllers of patient data and K Line Europe GmbH the processor, so each partner remains responsible for its own DPIA. This document is written so that K Line can assess its own risks as a processor and help partners with theirs [Legal to confirm the roles; see section 2].

## 2. Description of the processing

### 2.1 Roles (proposed)

| Data | Controller | Processor | Notes |
|---|---|---|---|
| Patient data in cases (names, patient or case IDs, dental models, trim lines, photos, instructions) | Partner company | K Line Europe GmbH | A data processing agreement (DPA, art. 28 GDPR) must be on file before uploads unlock (enforced in code). |
| Account data of partner and K Line users (name, work email, role, password hash, authenticator secret, sessions, IP address, user agent) | K Line Europe GmbH | [hosting and mail providers, see `SUBPROCESSORS.md`] | K Line decides the purposes (security, access control). [Legal to confirm whether any part is joint control.] |
| Registration data of companies (company, country, registrant's name and work email, website, expected volume) | K Line Europe GmbH | none | |
| Audit log (actions, actor, IP address, user agent) | K Line Europe GmbH for security; the partner also relies on it for its own accountability | | [Legal to confirm.] |

### 2.2 Data, subjects and sources

| Category | Examples | Where stored | Sensitivity |
|---|---|---|---|
| Patient identity | Patient name (optional for standard cases; first and last name mandatory for direct manufacturing), patient ID or case ID | Names: encrypted fields. IDs: plain text column `cases.partner_case_id` | Personal data; identifies a patient in a dental treatment context |
| Dental health data | STL models of teeth, PTS trim lines, number of steps and aligners, photos, PDFs, X rays if uploaded | Encrypted files in object storage; measurements in the database | Health data (art. 9 GDPR) |
| Free text | Case instructions (up to 8,000 characters), hold reasons, claim summaries and messages, file names | Instructions and file names: encrypted fields. Hold reasons, claim text, messages: plain text | May contain names or health details typed by people |
| Users | Name, work email, role, password hash (scrypt), encrypted TOTP secret, recovery code hashes, sessions with IP and user agent, notification settings | PostgreSQL | Personal data of staff |
| Registrants | Name, work email, company, website, volume band, acceptance of privacy notice version | `organizations.signup`, `users` | Personal data |
| Audit log | Who did what, when, from which IP address | `audit_log` | Personal data of staff; mentions patients only by case reference |
| Operational | Jobs, notifications, factory events, webhook deliveries, email notice log | PostgreSQL | References only; no patient names by design |

Data subjects: patients of the partner companies; users (partner staff and K Line staff); registrants.

### 2.3 Data flow

1. The partner's browser (or the partner API) uploads files to the Hub in Germany over TLS. Each file is encrypted with its own key and stored in object storage. The database holds metadata and encrypted fields.
2. The worker decrypts files in memory to scan them for malware (ClamAV) and to check them. Nothing is written in plain text.
3. Standard cases: the K Line factory system (MES) pulls the case for one production site and downloads files. The feed carries no patient names and no partner file names. Production sites are in Portugal, Egypt, Mexico and the United States in the demo configuration [K Line to confirm the real site list]. The transfer gate limits routing of EEA partner cases (see `TRANSFERS.md`).
4. Direct manufacturing cases: the Hub pushes the case, including the patient's first and last name, instructions and files, to the K Line customer portal (API v2.6). [K Line to confirm who operates the portal, where it is hosted and whether it is a separate processor.]
5. Results flow back: factory events and portal statuses update the case. Partners see progress and get notices and webhooks that carry references and counts, not names.
6. Partners and K Line staff view cases in the web app. Patient names are masked on screen. Showing a name is a deliberate, logged action.
7. After the retention period, case files, names, instructions and keys are purged (see `RETENTION.md`).

### 2.4 Recipients and locations

Hosting in Germany (Hetzner) [confirm]. An SMTP provider for emails [provider, location to confirm]. Backup storage [location to confirm]. K Line staff (all administrators). Factory sites per routing. For direct cases, the K Line customer portal. No analytics, advertising or other third party sees any data from the browser.

## 3. Necessity and proportionality

* **Purpose:** manufacture clear aligners that a dentist has prescribed for a patient, and let partners follow their orders. [Legal to set the legal bases for each controller.]
* **Data minimisation in design:** the patient name is optional for standard cases; it is encrypted, masked and kept out of logs, emails, webhooks, URLs and the factory feed. The factory receives canonical file names and never the partner's own file names (these may contain names).
* **Accuracy:** partners review the mapping of files before anything is sent, and warnings need explicit confirmation.
* **Storage limitation:** automatic purge of files and names after a per partner retention period (default 24 months after shipping) and after 30 days for cancelled cases. See `RETENTION.md` for what remains after a purge and what is not yet purged.
* **Transparency and rights:** the `/privacy` page is a short summary today. `PRIVACY_NOTICE_NOTES.md` lists what it must say. On demand erasure, access and rectification are done through the partner (the controller) and K Line staff. A partner administrator can erase a case on request (`POST /api/cases/:id/erase`, step up, audited); see R7 and R13.
* **Processor obligations:** assist controllers with rights, security, breach notification and DPIAs; engage sub-processors only with authorisation; delete or return data at the end. See `SUBPROCESSORS.md`, `BREACH_RUNBOOK.md`.

## 4. Risk assessment

Scale: likelihood and severity are Low, Medium or High, judged for the risk to patients and users, as it stands with the measures in place. "Residual" is the judgement after the measures. All ratings are proposals for the DPO and Legal to confirm.

| ID | Risk | Likelihood | Severity | Residual |
|---|---|---|---|---|
| R1 | One partner (or a key or session of a partner) reads another partner's cases | Low | High | Low |
| R2 | Misuse of patient names by insiders, or after account compromise | Medium | High | Medium |
| R3 | Account takeover of a user (phishing, password reuse, stolen session) | Medium | High | Medium |
| R4 | Malicious or malformed upload harms the platform or partners | Medium | High | Low |
| R5 | Loss or exposure of encryption keys, storage or backups | Low | High | Medium |
| R6 | EEA patient data reaches a production site outside the EEA without safeguards | Medium | High | Medium |
| R7 | Data kept longer than necessary, or cannot be erased on request | Medium | Medium | Medium |
| R8 | Data leaks through integrations: API keys, webhooks, exports, portal push | Medium | High | Medium |
| R9 | Patient data in unencrypted free text, emails, logs or identifiers | Medium | Medium | Medium |
| R10 | Tampering with or loss of the audit trail; breach not detected or not reported in time | Low | High | Medium |
| R11 | Self registration abused to get access, or to find out who has an account | Medium | Medium | Low |
| R12 | A processor, sub-processor or connected K Line system fails or discloses data | Low | High | Medium |
| R13 | Data subject rights not met in time (access, rectification, erasure, objection) | Medium | Medium | Medium |

### R1. Cross tenant access

**Risk.** A bug, a wrong query or a stolen key lets one partner read another partner's cases or files.

**Measures (implemented).**
* Application checks on every route (`guard`, organisation scoped queries) and PostgreSQL row level security with `FORCE`, enforced for the restricted role `kph_app` (`db/index.ts`, `migrations/001_init.sql`). The context is set in the same transaction as the queries.
* Partner API keys see only their own organisation; K Line service keys never work on partner routes (`app.ts`).
* File encryption uses per file keys bound to the file id in the additional data, so ciphertext moved to another file fails to open (`crypto/envelope.ts`).
* Tests check isolation through the API and through the database with the restricted role.

**Gaps.** No independent penetration test yet. **Residual: Low**, pending the test.

### R2. Misuse of patient names

**Risk.** A user reads names they do not need, or an attacker with a valid account reveals many names.

**Measures.** Names are encrypted with row bound additional data, masked on screen (`M*** A*****`) and revealed one case at a time by an action that writes `case.name_revealed` to the partner's access log, including every K Line reveal. API access to names needs the separate scope `patients:read` and is logged (`case.names_revealed` per page). Exports with names need `case.reveal_name` plus a fresh step up and are logged. The factory feed and webhooks never contain names. K Line searches by name and views of a case are logged to the partner.

**Gaps.** Every K Line account is an administrator (`kl_admin`) and holds `case.reveal_name`, so anyone at a factory site who is given an account can reveal names, although production does not need them [decision, see `OPEN_DECISIONS.md`]. Bag print files can contain names when the partner's layout allows it (audited). **Residual: Medium** until the question of who at the factory sites gets an account is decided.

### R3. Account takeover

**Risk.** Stolen credentials or sessions give access to patient data.

**Measures.** Mandatory password plus authenticator code for every user; password policy; scrypt hashing; lockout with doubling time; replay protection on codes; five wrong codes end the session; server side sessions with idle and absolute timeouts, `HttpOnly` `SameSite=Strict` `__Host-` cookie; CSRF token; step up for sensitive actions; sessions revoked on password change, role change, disabling and authenticator reset; partners can see and revoke their sessions; K Line staff administration needs step up (`routes/auth.ts`, `auth/sessions.ts`).

K Line staff can optionally sign in with Google Workspace (`OIDC_*` settings). Only existing staff accounts of the allowed domain are accepted, nothing is created automatically, and the authenticator code is always required afterwards.

**Gaps.** No phishing resistant factor (WebAuthn). No breached password check. `OIDC_REQUIRE_LOCAL_MFA=false` is refused at start up, so Google alone never gives a full session. **Residual: Medium.**

### R4. Malicious or malformed uploads

**Risk.** Malware, hostile PDFs or SVGs, or oversized models harm staff machines, the factory or the platform.

**Measures.** Type allow lists per purpose; executables refused by extension and magic bytes; ClamAV scan of every file with fail closed behaviour; blocking checks for PDF scripts and launch actions, SVG scripts and external references; formula injection warnings in CSV; limits on size and count; edge analysis cap for models; the server never unpacks archives (`services/validate/*`, `services/scanner.ts`, `services/files.ts`).

**Gaps.** The ClamAV stream limit must be raised in production to match the 512 MB file limit, otherwise large honest files are rejected. **Residual: Low** once the scanner is configured.

### R5. Keys, storage and backups

**Risk.** Master keys leak, or storage and backups are read by an unauthorised person.

**Measures.** Only ciphertext is in storage and the database holds wrapped keys and encrypted fields; master keys are environment configuration outside the database; key ids allow rotation and `cli rewrap` re-wraps file keys and re-encrypts fields in batches, with a check at the end; keyed hashes that cannot be recreated use a separate key id so a rotation never invalidates API keys or recovery codes; storage keys are opaque; no public or presigned URLs; `MASTER_KEYS` is validated at start (`config.ts`).

**Gaps.** Backups are encrypted with `age` for an offline key and kept 35 days, and the guide includes a restore test, but custody of the offline keys and the monthly test are people tasks. The rotation procedure has not been rehearsed on a copy of production data, and key custody (who holds the master keys and their separate backup) is an organisational task. A loss of the master keys is a loss of the data. Plain metadata (emails, case references, patient IDs of direct cases, free text) is in database backups. Access control on the server, the real secret storage and the restore tests are deployment tasks to confirm (`deploy/hetzner/README.md`). **Residual: Medium.**

### R6. Transfers outside the EEA

**Risk.** Cases of an EEA partner are produced at a site in a country without an adequacy decision and without safeguards.

**Measures.** The transfer gate (`shared/geo.ts`) blocks submitting or routing a case of an EEA partner to a site that is outside the EEA, not in an adequacy country, and without a valid SCC agreement on file (`403 transfer_blocked`). K Line sees in the console why a site is not allowed. The factory feed carries no names. Production staff are limited to their own sites. See `TRANSFERS.md`.

**Gaps.** The gate is checked at submit and at routing only; a case already at a site is not re-checked if the SCC later expires or is withdrawn. A partner outside the EEA is not restricted by the gate. The adequacy list in code is static and must be reviewed. The US is not on the list, so US sites need SCCs unless an adequacy flag is set for a certified recipient [Legal to decide]. Where the factory systems and the customer portal are hosted is not controlled by the Hub [confirm]. A transfer impact assessment for each country is still to be done. **Residual: Medium.**

### R7. Retention and erasure

**Risk.** Data stays longer than needed or cannot be removed when the controller asks.

**Measures.** Daily purge of case files, names, instructions and key material after shipping plus the partner's retention months (1 to 180, default 24), after 30 days for cancelled cases, and deletion of drafts after 30 days of inactivity, abandoned uploads after 2 days, and other bookkeeping (see `RETENTION.md`). Key material is removed in the same transaction as the purge, so leftover bytes cannot be read. Declined and unconfirmed registrations are deleted after 30 and 7 days.

**Gaps.** What stays after a purge (since 5 Oct 2026 the patient ID of direct cases, hold reasons, claim text and messages, and case IDs in webhook payloads are scrubbed with the purge): the case record with its reference, the partner case ID of standard cases, dates, counts and file measurements; case events without free text; material records; user accounts. The audit log is trimmed only by a manual command. Erasure on request exists since 5 Oct 2026 (it does not reach the K Line portal copy of direct cases, factory systems, follow up cases or backups). Backups are outside the software. **Residual: Medium.**

### R8. Integrations

**Risk.** API keys, webhooks, exports or the portal push expose data to the wrong party.

**Measures.** Keys shown once, stored as keyed hashes, scoped, expiring (at most 730 days), optionally limited to IP ranges, revocable, with last use recorded. Webhook secrets encrypted; payloads carry references and counts only and are signed; SSRF protection on webhook and portal addresses with checks at connect time; redirects not followed; `https` required in production. CSV cells are defused against formula injection. Name exports need a separate permission and step up. Integration management needs step up and an approved company. Portal credentials are stored encrypted and their use is logged.

**Gaps.** Webhook delivery has not been tested over real TLS. For direct cases the `case_id` in webhooks and exports is the patient ID. **Residual: Medium.**

### R9. Patient data in free text and identifiers

**Risk.** People type names or health details into fields that are not encrypted, or folder names with names become case IDs.

**Measures.** The interface warns not to type patient names in claims and materials. Logs redact tokens, search terms and case keys; emails and notifications carry fixed text and references only; job payloads hold ids; events for the factory carry no names; file names are encrypted and never reach the factory.

**Gaps.** Claim summaries, descriptions, messages, hold reasons, factory event notes and material names are plain text. Folder names used as case IDs may contain a name (`OPEN_DECISIONS.md`). Instructions are passed to the factory "as written" and may contain names. **Residual: Medium.**

### R10. Audit trail and breach handling

**Risk.** An attacker or insider hides actions, or a breach is not seen, assessed and reported in time.

**Measures.** Append only, hash chained audit log written for every security relevant action; partners read their own organisation's entries; a trigger blocks update, delete and truncate; chain verification in the console and on the command line; request ids; `BREACH_RUNBOOK.md` describes the 72 hour process.

**Gaps.** The chain head is not anchored outside the database, so someone with owner access could rewrite the whole chain. There is no central monitoring or alerting in the repository. **Residual: Medium.**

### R11. Self registration abuse

**Risk.** Fake companies gain access, or the form reveals who already has an account.

**Measures.** Email confirmation, K Line review, identical answers and a time floor for every outcome, honeypot, rate limits and a daily ceiling, throwaway domain blocking, fixed text emails that never repeat typed text, uploads and integrations locked until approval and a DPA, deletion of unconfirmed and declined registrations.

**Gaps.** No sanctions or identity screening of registrants (`OPEN_DECISIONS.md`). The invitation form for signed in users reveals whether an email address is already in use. **Residual: Low.**

### R12. Processors and connected systems

**Risk.** The hosting provider, mail provider, a factory system or the customer portal suffers a breach or discloses data.

**Measures.** Only ciphertext in storage; emails carry no patient data; the factory feed and webhooks carry no names; K Line service keys are scoped, expire and are logged; all access by the factory is visible to partners. Sub-processors are listed in `SUBPROCESSORS.md`.

**Gaps.** DPAs with the providers, their security assurances, the customer portal's hosting and security, and the factory systems are outside the software and must be confirmed. **Residual: Medium.**

### R13. Data subject rights

**Risk.** Patients or users cannot obtain access, correction, erasure or restriction in time, or K Line cannot help its partners to do so.

**Measures.** The partner can find a case by exact patient name (blind index) and export the case package; access and reveal events are logged; retention purges automatically; the privacy page names the contact; users can change their password and sessions.

**Gaps.** Partner administrators can erase a case (R7) but there is no restriction of processing; no documented process for a partner's request to K Line (see `RETENTION.md` for what can be removed by hand); no export of "all data about a person" across cases; users cannot change their own name or email (an administrator asks K Line). **Residual: Medium.**

## 5. Conclusion and next steps (proposal)

The design gives strong protection against the highest risks (cross tenant access, stolen files, malware). The remaining medium risks are mostly about organisational matters that the software cannot settle: transfers to production sites outside the EEA, retention of residual data, rights handling, provider assurances, and a missing penetration test. [DPO and Legal to decide whether the residual risks are acceptable and whether prior consultation of a supervisory authority (art. 36) is needed.]

Before real patient data is processed:

1. Legal and Compliance review this set of drafts and set the legal bases.
2. Sign DPAs with partners and confirm the sub-processor list and their agreements.
3. Complete the transfer impact assessments and SCCs for each non EEA site in use.
4. Close or accept the gaps in `OPEN_DECISIONS.md` (K Line account rights and names, erasure process, free text, audit anchoring).
5. Commission an independent penetration test (see `../SECURITY.md`).
6. Test the breach runbook with an exercise.
7. Review this DPIA again after the first 6 months of production use or after a major change.

Sign off: [DPO name and date] [System owner name and date] [Legal and Compliance name and date]
