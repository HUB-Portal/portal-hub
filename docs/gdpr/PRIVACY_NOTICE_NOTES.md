# Notes for the privacy notice (`/privacy`)

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It lists what the privacy notice should say, based on what the software collects on 30 Sep 2026. Legal must write the final text and choose legal bases. [Square brackets] mark items to decide or fill in.

## 1. What the page says today

`web/src/pages/auth/Privacy.tsx` is a short summary (version `2026-09`, constant `PRIVACY_VERSION` in `shared/signup.ts`). It says who K Line is, that K Line is processor for patient data, what is kept (account details, case files, checks, access log), that names are optional, encrypted, masked and their reveal is logged, that files are encrypted and stored in Germany, that there is no analytics and only the session cookie, the rights to access, correct and remove (with the `PRIVACY_EMAIL` address from `/api/public/config`) and what happens to company registrations (kept to confirm the email and decide on approval; deleted after 7 days if unconfirmed and after 30 days if declined).

It is a summary. The notes below show what a full notice needs. When the text changes in a way that matters to registrants, change `PRIVACY_VERSION`: the registration form records the accepted version and refuses a stale one.

## 2. Two audiences

1. **Users of the Hub** (partner staff, K Line staff, registrants). K Line is the controller of their data.
2. **Patients.** Their data is processed by K Line as processor for the partner. The partner's own notice must tell patients about it. K Line can supply text for partners (section 6).

The `/privacy` page should say clearly which part applies to whom.

## 3. Checklist of content for users (K Line as controller)

| Topic | What to say | What the code collects or does |
|---|---|---|
| Controller | K Line Europe GmbH, [address], contact, data protection officer [name] | `PRIVACY_EMAIL` and `SUPPORT_EMAIL` are shown from configuration |
| Purposes and legal bases | Account administration and secure access; security and misuse detection; audit log; registration review; notices and emails; support [Legal to assign bases] | See the record of processing, Part B |
| Account data | Name, work email address, role, organisation, sites, password (stored only as a hash), authenticator secret (stored encrypted), ten recovery codes (stored as hashes), notification setting, last sign in | `users` table |
| Sign in and session data | Session token (stored as a hash), time stamps, IP address, browser description (user agent), counters of failed sign ins and locks | `sessions`, `users` |
| Google sign in (K Line staff only, optional) | Google sends the Hub the staff member's email address, verified status, domain and a stable Google account id (`sub`), which the Hub stores in `users.oidc_subject`. Temporary flow records are kept for at most 10 minutes (1 day for cleaning). Google sees the sign in. | `oidc_flows`, `users.oidc_subject` |
| Audit log | Every security relevant action with the person, time, IP address and browser description. Partners can read the entries about their own organisation, including the names of K Line staff who accessed their data, or "K Line staff" without names in some views | `audit_log`; the partner's Access log shows K Line staff as "K Line staff" |
| Registration | Company name, country, registrant's name and work email, website, expected volume, acceptance of authority and privacy notice and its version, confirmation and decision times, whether the email is a free mail address | `organizations.signup` |
| Decline and deletion | Unconfirmed after 7 days; declined 30 days after the decision | `retention.ts` |
| Email | What emails are sent (invitation, password reset, registration, case and claim notices, low stock, webhook switched off). Emails contain one sentence and a link, never patient data. Users can switch case notices off; invitation, reset and registration emails cannot be switched off | `services/mail.ts`, `users.notify_email` |
| Cookies and storage | One essential session cookie (`__Host-kph_session` in production), `HttpOnly`, `Secure`, `SameSite=Strict`. No analytics, advertising or third party requests. The web app does not use local storage, session storage or IndexedDB (nothing in `web/src` calls them as of 30 Sep 2026). | `auth/sessions.ts`, `app.ts` (CSP) |
| Recipients | Hosting and backup provider, email provider (see `SUBPROCESSORS.md`), K Line staff by role, and the partner organisation for the data about its own users and its own access log | |
| Transfers | Account data stays in Germany. [Say so once confirmed.] | |
| Retention | The periods in `RETENTION.md`, with the points that are still open (accounts of approved companies, audit log period) | |
| Rights | Access, rectification, erasure, restriction, objection, portability where they apply, withdrawal of consent where consent is the basis, and complaint to a supervisory authority [name] | There is no self service for rights today: name the process and the address |
| Automated decisions | None | |
| Security | Short description only: encryption, two factor sign in, logging, German hosting | |
| Changes | Version and date. The page shows the version | `privacyVersion` |

Some details that are easy to forget:

* **Users cannot change their own name or email address in the Hub.** An administrator does it [check wording].
* **Staff accounts and IP addresses** in the audit log stay as long as the log is kept (default 36 months when trimmed; trimming is manual).
* **Free email addresses are accepted** for registration but flagged for review. Throwaway domains are refused. Say why.
* **Company logos and documents** uploaded to the profile are business documents, not patient data. Tell partners not to upload patient data there.

## 4. What the notice must say about patient data (K Line as processor)

The notice on `/privacy` should state briefly and link to the partner's DPA:

* K Line acts only on the partner's documented instructions.
* What is processed for the partner: case files (dental models, trim lines, documents), optional patient names or, for direct manufacturing, first and last name and patient ID, instructions.
* Stored encrypted in Germany. Patient names are masked and every reveal is logged to the partner.
* Where production happens and which sites may receive data (depending on the partner's country, SCCs), see `TRANSFERS.md`.
* Sub-processors and how partners are told about changes (`SUBPROCESSORS.md`).
* Retention (`RETENTION.md`).
* How K Line helps the partner with rights requests, security, breach notification (`BREACH_RUNBOOK.md`) and DPIAs.
* The contact for privacy questions. Patients should contact the partner first.

## 5. Where personal data appears in the product (for the data map)

| Place | Data | Notes |
|---|---|---|
| Case (`cases`) | Encrypted patient name, first name, last name, instructions; plain partner case ID (patient ID for direct cases) | Name blind indexes are HMACs |
| Files (`files`, storage) | Encrypted content and encrypted file names | Opaque storage keys |
| Claims | Plain text summaries, descriptions, messages, item notes; evidence photos, videos and PDFs (encrypted files) | Interface warns not to type patient names |
| Case events | Plain text hold reasons and notes | |
| Webhooks | Case reference, partner case ID, status, site, carrier, tracking number, aligner counts | No names |
| Exports and API | Names only with the name permission and step up (exports) or the `patients:read` scope (API), logged | |
| Bag print file | Personal tokens only if the partner's layout allows | Audited |
| Factory feed | No names; instructions as written | |
| K Line customer portal (direct manufacturing) | First and last name, instructions, files | |
| Notifications and emails | References only | |
| Logs | IP addresses and request paths; tokens, search terms and case keys hidden | |

## 6. Text for partners' own notices to patients (suggestion)

"Your dentist or clinic [partner name] uses K Line Europe GmbH, Germany, to manufacture your aligners. For that, K Line receives digital models of your teeth and treatment data, and in some cases your name and a patient number. K Line stores this information in encrypted form in Germany and processes it only on our instructions. The aligners may be made at a K Line production site in [countries]. Where a site is outside the European Economic Area we use [safeguards]. We keep the data for [period] after the aligners are shipped."

[The partner's Legal team must adapt this.]

## 7. Things to fix or decide before publishing the final notice

1. Legal bases, retention periods for accounts and registrations, audit log period.
2. The rights process and who answers which request.
3. The list of sub-processors and production locations.
4. Whether K Line staff names appear to partners in the access log (the code shows "K Line staff" for some entries and real names in others; check the wording).
5. Cookie statement: one essential session cookie, plus, only for K Line staff who sign in with Google, a short lived cookie (`kph_oidc`, `__Host-kph_oidc` in production, 10 minutes, `HttpOnly`) that ties the sign in to the browser. No other browser storage today. Re-check when the web app changes.
6. A link from the registration form, the sign in page and the footer of emails to the final notice, and a translation plan for German and other languages [decision].
7. Update `PRIVACY_VERSION` when the final text is published.
