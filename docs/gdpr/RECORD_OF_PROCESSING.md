# Record of processing activities (art. 30 GDPR)

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It is a starting point built from what the Portal Hub does on 30 Sep 2026. [Square brackets] mark details that K Line must fill in or confirm. Legal bases and roles are proposals.

Two records follow. Part A is K Line Europe GmbH as **processor** for the patient data of its partner companies (art. 30(2)). Part B is K Line Europe GmbH as **controller** for account, registration and security data (art. 30(1)).

## Part A. K Line Europe GmbH as processor

### A.1 Processor and representatives

| Item | Entry |
|---|---|
| Processor | K Line Europe GmbH, [registered address] |
| Contact for data protection | [Data protection officer or contact name and email]. The Hub shows the value of `PRIVACY_EMAIL`: [PRIVACY_EMAIL] |
| Representative in the EU (if needed) | Not needed if the processor is established in the EU [Legal to confirm] |

### A.2 Controllers on whose behalf K Line acts

Each partner company that has a signed data processing agreement (DPA) recorded in the Hub. The Hub keeps the list of partners, their country, their DPA and other agreements (`agreements` table, viewable in the console under Partners). [Export the list of controllers with contact details from the console before each review.]

### A.3 Categories of processing

| Processing | Purpose (set by the controller) | Systems |
|---|---|---|
| Receiving, scanning, checking and storing case files | Prepare clear aligner manufacturing | Hub API and worker, ClamAV, object storage |
| Displaying cases, masked names, 3D models and trim lines | Let the partner and K Line staff review cases | Hub web app |
| Routing, holding and releasing cases | Decide where a case is produced | Hub console |
| Supplying case data to production | Manufacture the aligners | MES feed (`/api/mes/v1`) for standard cases; K Line customer portal for direct manufacturing cases |
| Tracking status, shipping and notifications | Keep the partner informed | Hub, email, webhooks |
| Quality claims, reworks and replacements | Handle faults and remakes | Hub claims |
| Invoicing data supply | Give the partner shipment lists | `GET /api/v1/shipments`, CSV exports |
| Retention and deletion | End of purpose | Retention job |

### A.4 Categories of data subjects and data

| Data subjects | Data |
|---|---|
| Patients of the partner (and of the partner's dentists) | Name (optional or mandatory, see below), patient or case ID, dental 3D models (STL), trim lines (PTS), treatment step numbers, number of aligners, optional photos, PDFs, X rays and instructions supplied in files or text, laser marking text in CSV files |
| Partner staff appearing in case data | Names in free text, where typed by the partner |

Special category data (health) is involved. Direct manufacturing cases require the patient's first name, last name and patient ID.

### A.5 Recipients

| Recipient | Role | Data |
|---|---|---|
| K Line staff (all administrators) | Employees of the processor | Names can be revealed by every K Line account; every reveal is logged to the partner |
| Hosting provider (Hetzner, Germany) [confirm] | Sub-processor | Encrypted files and database |
| Backup storage box [confirm] | Sub-processor | Encrypted backups |
| SMTP provider [name to fill in] | Sub-processor | Recipient email addresses and fixed text notices, no patient data |
| Production sites (PT-CHV, EG-CFZ, MX-TIJ, US-WPB, US-MEM in the demo configuration) [confirm the real list and operating entities] | Group company or sub-processor | Models, trim lines, instructions, reference numbers. No names |
| K Line customer portal (direct manufacturing) [confirm operator and hosting] | Processor system | Patient first and last name, instructions, all files |

See `SUBPROCESSORS.md`.

### A.6 Transfers to third countries

Only to production sites outside the EEA, governed by the transfer gate (`shared/geo.ts`) and by SCCs where needed. See `TRANSFERS.md`. The Hub itself is hosted in Germany and has no other transfer.

### A.7 Time limits

Case files, names, instructions and keys: shipping date plus the partner's retention period (default 24 months, between 1 and 180 months). Cancelled cases: 30 days. Drafts: 30 days after the last change. Details and remaining data are in `RETENTION.md`.

### A.8 Security measures

See `TOMs.md` and `../SECURITY.md`.

## Part B. K Line Europe GmbH as controller

### B.1 Controller

K Line Europe GmbH, [registered address], managing director [name]. Contact for privacy: [PRIVACY_EMAIL]. Data protection officer: [name, if appointed].

### B.2 Processing activities

| # | Activity | Purpose | Categories of data subjects | Categories of data | Source | Recipients | Retention | Legal basis [Legal to decide] |
|---|---|---|---|---|---|---|---|---|
| B1 | User accounts and access control | Give partner and K Line staff secure access | Partner users, K Line staff | Name, work email, role, organisation, site, password hash, encrypted authenticator secret, recovery code hashes, last sign in, notification setting | The user, the invitation | Hosting, email provider | While the account exists. Accounts are not deleted automatically. [Define.] | [Contract / legitimate interest] |
| B2 | Sessions and sign in security | Secure sign in, detect misuse | Users | Session token hash, IP address, user agent, time stamps, failed sign in counters | The browser | Hosting | Sessions: 7 days after expiry or revocation | [Legitimate interest] |
| B2a | Google sign in for K Line staff (optional) | Let staff sign in with their Workspace account | K Line staff | Email address, stable Google account id (`users.oidc_subject`), temporary flow records | Google Workspace | Google (as identity provider) | Account id: while the account exists. Flow records: at most 10 minutes, cleaned after 1 day | [Legitimate interest] |
| B3 | Audit log | Accountability, security investigation, show partners who accessed their data | Users, API key holders | Action, actor, organisation, IP address, user agent, target references | Generated | Partners (their own organisation's entries) | Kept until trimmed; default 36 months by `audit-trim` (manual) | [Legitimate interest, legal obligation] |
| B4 | Company registration and review | Decide whether to admit a partner | Registrants | Company name, country, registrant name and work email, website, volume band, privacy notice version, confirmation and decision times | The registrant | K Line administrators | Unconfirmed: 7 days. Declined: 30 days after the decision. Approved: stays on the organisation record [define] | [Contract steps / legitimate interest] |
| B5 | Agreements and onboarding | Record DPAs, SCCs and other agreements | Signatories (names in `signed_by`) | Agreement type, dates, reference, notes | K Line | K Line | [Define] | [Contract / legal obligation] |
| B6 | Notifications and emails | Tell users about cases, claims, invitations, password reset | Users | Email address, fixed text messages | Generated | SMTP provider | Notifications 180 days; email notice bookkeeping 2 days; queued email jobs 14 days after finishing | [Contract / legitimate interest] |
| B7 | Rate limiting and registration bookkeeping | Prevent abuse | Visitors, registrants | Attempt time stamps, hashed address with notice kind and time | Generated | none | 2 days and 1 day | [Legitimate interest] |
| B8 | Factory event log | Operate the integration with the factory system | none (references only) | Event id, case reference, stage code, outcome | Factory system | none | 180 days | [Legitimate interest] |
| B9 | Webhook delivery log | Operate partner webhooks | none (references only) | Payload with references and counts, status | Generated | Partner's endpoint | 90 days | [Contract] |
| B10 | Support communication | Answer questions | Users | Email content | The user | K Line | [Define] | [Legitimate interest] |
| B11 | Web server logs | Operation and security | Visitors, users | Method, URL (tokens hidden), status, IP address, request id | Generated | Hosting | [Define log retention in the deployment] | [Legitimate interest] |

### B.3 Transfers and security

Account data stays in Germany. Email goes through the SMTP provider [location to confirm]. See `SUBPROCESSORS.md`, `TOMs.md`.

## Review

Review at least once a year and whenever processing changes. Last reviewed: [date]. Reviewed by: [name].
