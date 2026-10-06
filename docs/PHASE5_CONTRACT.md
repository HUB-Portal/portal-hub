# Phase 5 contract: organisations, self registration and K Line review

Status: **server implemented and tested** (`shared/signup.ts`, `server/src/routes/{signup,profile,partners,demo}.ts`, `services/{signup,profile,partnerReview,org,retention,files,mail}.ts`, migration `005_signup_profile.sql`, tests `phase5.unit.test.ts`, `phase5.test.ts`, `phase5.delete.test.ts`). **This file matches the code.** Source: original brief sections 11 (company profile, team), 12 (Partners), 13 (self registration and onboarding), 19 (retention of registrations), 20 (demo). Phases 1 to 4 are done (BRIEF.md, PHASE2/3/4 contracts).

Conventions are those of PHASE2 to 4: JSON under `/api`, session cookie plus `x-csrf-token` on writes (not on the two public writes below), errors `{code, message, ...extra}`, `400 invalid_request` carries `fields: [{path, message}]`, camelCase for everything the web app sees. Send `{}` as the body of POST requests without data. "Step up" means an authenticator code within the last 10 minutes, else `403 step_up_required`. No patient data anywhere; interface text is plain British English without dash separators.

## 0. Data model (migration 005, additive)

* `organizations.address_details jsonb` (`{street, city, postalCode, country}`); the old text column `address` is kept as a single formatted line. Existing `contacts` and `signup` jsonb columns are used as they were.
* `brands.logo_file_id`, `brands.updated_at`; `files.doc_kind` (`qc_criteria|packaging|other`, documents only).
* New tables `signup_attempts` (one row per attempt that passed validation, for the daily ceiling; only a timestamp) and `signup_mail_log` (hash of the address + kind + time; throttles the fixed notices to one an hour). Both are K Line (bypass) only under row level security; retention removes rows after 2 days and 1 day.
* `organizations.signup` (self registered companies only): `{at, email, name, website, volume, free_email, privacy_version, authority_accepted_at, verified_at, approved_at?, approved_by?, declined_at?, declined_by?, decline_reason?}`. A company is "self registered" when `signup.at` exists. The registrant's typed company name is only in `organizations.name`.

## 1. Shared code: `shared/signup.ts` (server and web)

`PRIVACY_VERSION = '2026-09'`; `COUNTRIES` (`{code, name}`, 250 entries: ISO 3166-1 alpha 2 plus `XK` Kosovo, sorted by English name), `isCountryCode`, `countryName`, `EU_COUNTRIES`, `isEuCountry`; `VOLUME_BANDS` (`under_1000`, `1000_5000`, `5000_20000`, `over_20000`; labels are "cases a year"), `volumeLabel`; `cleanText`; `validateCompanyName`, `validatePersonName` (letters in any script, digits, spaces, `. , ' ’ & - ( )`, 2 to 120 characters, refuse `<>@/\`, schemes, `www.` and anything that looks like a domain name), `validateWebsite` (optional, http or https, max 200, needs a dot in the host, no credentials), `validateEmail` (lower cased; syntax only), `THROWAWAY_DOMAINS` (140 domains, matched with sub domains) with `isThrowawayDomain`, `FREE_MAIL_DOMAINS` and `isFreeMailDomain` (also gmx.*, yahoo.*, hotmail.*, outlook.*, live.*, icloud.* families), `THROWAWAY_MESSAGE`, `validateRegistration(body) -> {ok, value} | {ok: false, problems: [{path, message, code?}]}` (the whole form, never touches a database), `suggestCompanyCode(name)` (initials of 3 or more words, at most 8; otherwise the first four characters of the first word; legal forms GmbH, Ltd, LLC, SL, SA, UAB, BV, AG, Inc, Co, Limited and more are ignored; accents folded; always `^[A-Z0-9]{2,8}$`; `KL` is never returned), `codeCandidates(name)` (the suggestion then `CODE2 ... CODE20`), `isValidCompanyCode`, `COMPANY_CODE_RE`, `RESERVED_CODES = ['KL']`.

## 2. Public routes (no session)

* `GET /api/public/config` -> `{privacyEmail, supportEmail, signupEnabled, privacyVersion}`.
* `POST /api/auth/register` body `{companyName, country (ISO code), personName, email, website?, volume?, acceptAuthority: true, acceptPrivacy: true, privacyVersion: "2026-09", hp?}`. CSRF exempt. Rate limit: 5 requests per 10 minutes per IP (`429 rate_limited`, counts malformed requests too).
  * `403 signup_disabled` when `SIGNUP_ENABLED` is off.
  * `hp` (honeypot) filled: `202` with the usual answer, nothing done, not counted.
  * Malformed: `400 invalid_request` with `fields: [{path, message}]` (paths are the body field names), answered at once. A throwaway mailbox only: `400 email_not_allowed` with the "please use your work email" message (`fields` names `email`); when other fields are wrong as well the code is `email_not_allowed` and the fields list all problems. A stale `privacyVersion` is a field problem on `privacyVersion`.
  * Everything else (**new address, existing account, unconfirmed, declined, over the daily ceiling, internal error**) returns **`202 {ok: true, message}`** with one fixed `message`, and never faster than `SIGNUP_MIN_MS` (600 ms; tests lower it; production refuses less than 600).
  * The daily ceiling (`SIGNUP_DAILY_LIMIT`, default 100 in a rolling 24 hours) counts every attempt that passed validation and is checked before the address is looked at. Over it: usual answer, nothing done, K Line administrators are alerted once a day (in app `signup_ceiling` plus one email each, fixed text).
  * New address: one transaction creates the partner organisation (`status 'onboarding'`, name as typed, code from `codeCandidates` with a random fallback, `settings.manual_review true`, `signup` as above), an `admin` user (`status 'invited'`, no password) and a draft specification version 1 (default template), a 48 hour single use `verify` token and a queued email with the fixed text and the link `PUBLIC_URL/verify?token=...`. Audit `signup.registered` (no typed text).
  * Existing account (any user of an approved/suspended company, a K Line user, or a confirmed registration): fixed "you already have an account" email, at most once an hour per address; nothing created.
  * Declined registration: fixed "not approved" notice, at most once an hour per address.
  * Unconfirmed registration: a fresh link (the earlier link stops working), at most 3 an hour and 5 in total per registration (the first link counts); **nothing stored is ever changed by the form**.
* `GET /api/auth/verify/:token` (10 per minute) -> `200 {valid: true, email, name, orgName}` or `200 {valid: false}` (never an error, so a bad link says nothing). `orgName` is the company name the registrant typed; only the holder of the link sees it.
* `POST /api/auth/verify` body `{token, password}` (CSRF exempt, 10 per minute). Same password policy as invitations (`400 weak_password`, `400 invalid_token`). Success `200 {stage: 'mfa_setup', csrfToken}` with the session cookie set, exactly like `POST /api/auth/invite/accept`. It sets the password, marks `signup.verified_at` (first time only), keeps the user `invited` until the authenticator setup is confirmed, and tells K Line administrators once: in app notification kind `signup_confirmed` (title "A new company is waiting for review", body "A new company has confirmed its email address.", `data.orgId`) plus an email to every active `kl_admin` with notices on, link `PUBLIC_URL/console/partners?tab=review`. Audit `signup.email_confirmed`. A user who stops before the authenticator can sign in later (`stage: 'mfa_setup'`) and finish the setup.
* Request logs redact `/api/auth/verify/<token>` and `?token=`.
* Demo mode only (`404` otherwise): `GET /api/demo/registrations` -> `{items: [{email, link, path, sentAt, expiresAt}]}` for registrations whose confirmation link is still live (read from the development mailbox). `path` is `/verify?token=...`. `GET /api/demo/mailbox` and `GET /api/demo/accounts` are unchanged.

### Emails (fixed text, `services/mail.ts`)

`signup_confirm` ("Confirm your email address for the Portal Hub"), `signup_existing`, `signup_declined`, `signup_approved`, `admin_new_signup`, `admin_signup_ceiling`. None of them contains anything the registrant typed (no company, no person name), no reference code and no reason for a decline; staff emails only say that a company is waiting and link to the review tab.

## 3. Approval gates while a partner is not approved (`organizations.status = 'onboarding'`)

* Signing in, editing the profile, brands, logos and documents (max 10 profile files), reading and proposing specifications and using the account all work.
* `403 org_not_approved` (message: "This feature unlocks when K Line has approved your company. See the getting started list on your overview."): case file uploads (phase 2), material shipments (phase 4), **team invites and resending invites** (new). Helper `assertApproved(auth)` in `services/org.ts` is ready for API keys and webhooks in phase 6 (none exist for partners yet).
* `409 profile_files_limit` when a not approved company already stores 10 logos and documents in total (uploads of `logo` and `document`). Lifted at approval. Other caps: 60 logo files, 200 documents.

## 4. Company profile (partner routes)

All routes below are for partner companies only (`403` for K Line staff). Permission `org.read` for reads, `org.edit` (partner `admin`) for writes. Not step up.

* `GET /api/org/profile` and `PUT /api/org/profile` -> the same profile:
  ```
  { id, name, code, status: "onboarding"|"active"|"suspended", approved: boolean,
    legalName, country (ISO), countryLocked (true when approved), vatId, vatRequired (country is in the EU),
    address: {street, city, postalCode, country},
    contacts: {operations, quality, finance, it}   // each {name, email, phone}, empty strings when not set
    settings: {caseIdRegex: string|null, requirePts: boolean},
    logo: {hasLogo}, profileFiles: {count, max: 10|null}, updatedAt }
  ```
  `PUT` body: every field optional, sent parts replace only themselves: `{name?, legalName?, country?, vatId? (upper cased, spaces removed; '' or null clears), address?: {street?, city?, postalCode?, country? ("" or ISO)}, contacts?: {operations?|quality?|finance?|it?: {name?, email? ("" or valid), phone? (digits, space, + ( ) - . /)}}, settings?: {caseIdRegex? (null or "" clears), requirePts?}}`. Text fields refuse `<`, `>` and control characters; the company name follows the registration rules. `caseIdRegex`: max 200 characters, must compile and must finish within 100 ms on hostile samples inside a separate V8 context (`400` with `fields: [{path: 'settings.caseIdRegex', message}]`). After approval the country cannot be changed here (`409 country_locked`; it decides the transfer gate, K Line changes it). Audit `org.profile_updated` with the names of the changed fields only.
* Brands: `GET /api/org/brands` -> `{items: [{id, name, hasLogo, createdAt}]}`; `POST /api/org/brands {name}` (1 to 80 characters) -> `201 {brand}`; `PATCH /api/org/brands/:id {name}` -> `{brand}`; `DELETE /api/org/brands/:id` -> `{ok}`. `409 brand_exists` (names are unique per company, case insensitive), `409 brand_in_use` (a case uses it), `409 too_many_brands` (50). The brand's logo file is deleted with it.
* Logos: upload with `POST /api/uploads {purpose: "logo", name, size}` then the normal chunk and complete routes (png, jpg, jpeg, svg; max 5 MB; SVG goes through the SVG checker, images by magic bytes; state `ready` or `rejected` after the worker ran). Then `POST /api/org/logo {fileId}` or `POST /api/org/brands/:id/logo {fileId}` -> `{hasLogo: true}`. Errors: `404` (unknown file, another company's file, a document), `409 file_not_ready`, `409 file_in_use` (already the logo of something else). The previous logo file is deleted. `DELETE /api/org/logo` and `DELETE /api/org/brands/:id/logo` remove it. `GET /api/org/logo` and `GET /api/org/brands/:id/logo` stream the decrypted image (`org.read`; `content-type` image/png, image/jpeg or image/svg+xml, `content-disposition: inline`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`); `404` when none. Logo files that were never used are removed by the retention job after 7 days.
* Documents: upload with `POST /api/uploads {purpose: "document", kind: "qc_criteria"|"packaging"|"other" (default other), name, size}` (pdf, jpg, jpeg, png; max 50 MB). `GET /api/org/documents` -> `{items: [{id, name, kind, ext, size, state: "processing"|"ready"|"rejected", problem: string|null, uploadedBy: string|null, createdAt}]}` (newest first). `DELETE /api/org/documents/:id` -> `{ok}` (audit `file.deleted`). Download with the existing `GET /api/files/:id/download` (needs `file.download`, audited as `file.download`; K Line staff downloads are written to the partner's log too).
* `GET /api/org/agreements` -> `{items: [{id, kind, signedAt, expiresAt, reference}]}` (only signed, not withdrawn; no notes, no signer names). `GET /api/org/sites` -> `{items: [{code, name, city, country, active, isDefault}]}`.
* `GET /api/org/onboarding` [org.read] -> `{items: [{id: "account_secured"|"profile"|"spec"|"dpa"|"approval", label, done}], approved}` in that order. Account secured: an active administrator has an authenticator. Profile: legal name, VAT id (only for EU countries), street, city, postal code and country of the address, and at least one contact with an email address. Spec: an active or proposed specification exists (the draft made at registration does not count). DPA: a valid DPA is on file. Approval: the company is active.
* The case ID pattern tester runs in the browser; the server exposes nothing extra.

## 5. K Line review (console, permission `admin.partners`, K Line only)

* `GET /api/partners?tab=all|review|declined&search=` -> `{tab, counts: {all, review, declined}, items}`. Default tab `all` = every partner **except declined ones**. `review` = self registered, `onboarding`, not declined (confirmed first, then unconfirmed, oldest registration first). `declined` = confirmed registrations K Line declined (most recent first). `search` matches name, code and the registrant's email (case insensitive; `%` and `_` are literal). Each item keeps the phase 3 fields (`id, name, code, status, country, retentionMonths, dpaOnFile, sccOnFile, usersCount, openCases, siteCodes, defaultSiteCode, createdAt`) and adds `newSignup` (self registered, `onboarding`, not declined), `emailNotConfirmed`, `declined`, `signupAt` (ISO or null), `freeEmail`, `volume` (band id or null), `declinedAt`, `deletesAt` (declined + 30 days; null otherwise).
* `GET /api/partners/:id` keeps its phase 3 shape and adds: `addressDetails {street, city, postalCode, country}`, `contacts`, `countryName`, `hasLogo`, `caseIdRegex`, `selfRegistered`, `emailConfirmed` (true for companies that did not self register), `declined`, `signup` (`null` unless self registered) `{registrantName, email, website, volume, volumeLabel, freeEmail, privacyVersion, registeredAt, confirmedAt, approvedAt, declinedAt, declineReason, deletesAt}`, and a richer **`gates`**: `{dpaOnFile, sccOnFile, qaaOnFile, msaOnFile, hasSite (an active site), emailConfirmed, declined, sccRequired (EEA partner with a site outside the EEA and without adequacy), sccMissing, canActivate, blockers: [{code, message}], sites}` where `code` is one of `partner_declined`, `email_not_confirmed`, `dpa_required`, `site_required` (these block Activate; SCC, QAA and MSA are shown but do not block, as before). `GET /api/partners/:id/logo` streams the company logo (`404` when none).
* `POST /api/partners` [step up] `{name, code, country, legalName?, retentionMonths? (1 to 180, default 24), siteCodes[] (default []), defaultSiteCode?}` -> `201 {id, code, status: "onboarding"}`. Code `^[A-Z0-9]{2,8}$` after upper casing (`400 invalid_code`), `KL` reserved (`400 code_reserved`), unique (`409 code_taken`), unknown site `400 invalid_site`. Manual review is on. No users yet. Audit `partner.created`.
* `POST /api/partners/:id/users/invite {email, name, roles}` [step up] -> `201 {id}`: an invited user of that partner (partner roles only) with the normal invitation email ("K Line has invited you to join <partner>"). `409 email_unavailable`, `409 partner_declined`, `404` for K Line or unknown ids. Audit `partner_user.invited` (in the partner's log).
* `PATCH /api/partners/:id/code {code}` (no step up) -> `{code}`. `409 has_cases` as soon as the partner has any case (drafts included), plus the code errors above. Audit `partner.code_changed {from, to}`.
* `POST /api/partners/:id/activate` -> `{status: "active"}`. Checks in this order: `409 partner_declined`, `409 email_not_confirmed` (self registered companies need `signup.verified_at`), `409 dpa_required`, `409 site_required`. On the first activation from `onboarding`: records `signup.approved_at/approved_by` (self registered), writes an in app notification to the company (kind `org_approved`, fixed text), queues the fixed "approved" email to every non disabled `admin` user of the company who has notices on (link `PUBLIC_URL/login`), audit `partner.activated`. Activating again sends nothing more.
* `POST /api/partners/:id/decline {reason? (max 500)}` [step up] -> `{status: "declined", deleted: boolean, deletesAt: ISO|null}`. Only self registered companies that are `onboarding` and not declined (`409 not_a_registration`, `409 not_declinable`, `409 already_declined`). **Unconfirmed**: the company, user, tokens and draft spec are deleted at once through `deleteOrganisation` (`deleted: true`), nobody is emailed; the audit entry `partner.registration_declined {code, confirmed: false, deleted: true}` keeps only the organisation id and code. **Confirmed**: `signup.declined_at/declined_by/decline_reason` are stored (the reason is internal only: not in emails, not in the audit entry, which has `hasReason`), all users are disabled and their sessions revoked, tokens retired, the fixed notice email goes to the registrant, `deletesAt` = now + 30 days; the retention job deletes everything then (audit `partner.registration_deleted {code, reason}`).
* `GET /api/console/overview` `newSignups` = confirmed registrations waiting for review (`onboarding`, not declined). Show a banner when above 0.

## 6. Retention additions (`services/retention.ts`, daily job and CLI)

Report gains `unconfirmedRegistrations` (self registered, email never confirmed, 7 days after `signup.at`; audit `signup.expired {code, reason}`), `declinedRegistrations` (30 days after `declined_at`), `unusedLogos` (logo files nobody uses, 7 days) and `signupRecords` (attempt and notice bookkeeping). Every deletion of an organisation goes through the single service `deleteOrganisation(c, orgId)` in `services/org.ts`: removes dependents in an order that never breaks a foreign key (notifications, jobs, sessions, tokens, files and chunks, materials, claims, cases, brands, specs, agreements, keys, sites, users, then the organisation), refuses K Line, never touches the audit log, and returns the storage prefixes to remove after the commit (`removeStoredPrefixes`). Existing `user_tokens` cleanup (30 days after expiry) covers `verify` tokens.

## 7. Seed and demo

Seed (`cli seed --force`, also in tests): **Contoso Smile** (code `CONT`, Spain; `owner@contoso.demo` "Olga Owner", registered itself, email confirmed, has a password and an authenticator like the other demo users, waiting for review, `free_email false`, volume `1000_5000`) and **Fabrikam Dental Lab** (code `FDL`, Germany; `owner@fabrikam.demo`, registered yesterday, email not confirmed, one live confirmation link that `GET /api/demo/registrations` lists). Both have a draft spec. The codes differ from `CONTOSO` and `FABRIK`, which older tests insert themselves. Adjusted tests: the phase 3 overview test expects `newSignups: 1`; the phase 4 "K Line sees everything" test expects two more draft specs.

## 8. Route table (new and changed)

| Method and path | Permission | Step up | Notes |
|---|---|---|---|
| GET /api/public/config | none | no | public |
| POST /api/auth/register | none | no | CSRF exempt, 5 per 10 minutes per IP, always 202, 600 ms floor |
| GET /api/auth/verify/:token | none | no | 200 `{valid}` |
| POST /api/auth/verify | none | no | CSRF exempt, starts a `mfa_setup` session |
| GET /api/demo/registrations | none | no | DEMO_MODE only |
| GET /api/org/onboarding | org.read | no | partner only |
| GET, PUT /api/org/profile | org.read, org.edit | no | partner only |
| GET /api/org/brands, POST, PATCH /:id, DELETE /:id | org.read, org.edit | no | |
| GET, POST, DELETE /api/org/logo | GET org.read; POST, DELETE org.logo (admin, uploader, quality, finance) | no | POST `{fileId}` |
| GET, POST, DELETE /api/org/brands/:id/logo | org.read, org.edit | no | |
| GET /api/org/documents, DELETE /api/org/documents/:id | org.read, org.edit | no | upload through /api/uploads |
| POST /api/uploads (purpose logo: org.logo; purpose document: org.edit) | see purpose | no | partner people only, no API keys |
| GET /api/org/agreements, GET /api/org/sites | org.read | no | |
| POST /api/team/invite, POST /api/team/:id/resend-invite | team.manage | invite: yes | now `403 org_not_approved` while onboarding |
| GET /api/partners (tab, search) | admin.partners | no | K Line only |
| POST /api/partners | admin.partners | yes | |
| POST /api/partners/:id/users/invite | admin.partners | yes | |
| PATCH /api/partners/:id/code | admin.partners | no | |
| POST /api/partners/:id/activate | admin.partners | no | new gates |
| POST /api/partners/:id/decline | admin.partners | yes | |
| GET /api/partners/:id/logo | admin.partners | no | |

## 9. Deviations from the first draft of this contract

1. `POST /api/auth/verify` is CSRF exempt (like invite accept, there is no session yet); the bookkeeping tables and the once an hour notice throttle are new, and `SIGNUP_MIN_MS` is a new setting (default 600, production refuses less).
2. `GET /api/auth/verify/:token` answers `200 {valid: false}` for a bad link instead of an error.
3. `PUT /api/org/profile` treats every field as optional (partial updates); the country becomes read only after approval (`409 country_locked`), which the draft did not say.
4. `GET /api/partners` gained `counts` and `tab`; the default tab `all` leaves out declined registrations, which only appear under `declined`.
5. The profile file limit answers `409 profile_files_limit` (not `org_not_approved`); profile files are not locked by the DPA gate, only limited.
6. Team invite lock also covers resending invites. API keys and webhooks have no partner routes yet; `assertApproved` is ready for them.
7. Extra routes: `GET /api/partners/:id/logo`, `DELETE /api/org/logo`, `DELETE /api/org/brands/:id/logo`. Extra settings: none other than `SIGNUP_MIN_MS`.
8. Documents keep their kind in `files.doc_kind`; the structured address is in `organizations.address_details` (the draft's single `address` column is text).
9. Volume band labels say "cases a year" (the brief did not name the unit).
10. Staff invited partner users through `inviteMember` now show the partner's name (looked up) and "K Line" as the inviter; team invites by partners are unchanged.

## 10. Web app

Public pages: `/register` (form with labels, country select from `COUNTRIES`, volume select from `VOLUME_BANDS`, authority and privacy checkboxes linking to `/privacy`, hidden honeypot field `hp`, always shows the same success message after a `202`, field errors for `400` from `fields`, friendly text for `429`; in demo mode lists the confirmation links from `/api/demo/registrations`), `/verify?token=` (`GET /api/auth/verify/:token`; choose a password with the same meter and policy text as invite accept; then the existing authenticator setup), sign in page gets a "Register your company" link when `signupEnabled` (from `/api/public/config`, which also gives the privacy contact for `/privacy`). Partner: **Getting started checklist** on the Overview while `!approved` (`/api/org/onboarding`), a notice for `org_not_approved` and `profile_files_limit` errors with a link to the checklist, **Company profile** page `/portal/company` (legal details, address, contacts, case ID pattern with live tester, logo and brands with logos, documents with upload and delete, agreements on file, allowed sites), Team page keeps working (invite shows the locked notice when not approved). Console: **Partners** page with tabs All, Waiting for review, Declined (badge counts from `counts`), badges New sign up, Email not confirmed, Declined, personal mailbox; **Add partner** dialog (step up); partner page additions: registration card (`signup`), compliance gates panel (`gates`, disabled Activate with the `blockers` messages), Decline dialog (reason; explains that an unconfirmed registration is deleted at once and a confirmed one after 30 days), change code (until the first case), invite user; overview banner and tile link for `newSignups`.
