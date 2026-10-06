# Architecture

Last checked against the code: 30 Sep 2026. This document describes what the code does today. The deployment files are in `deploy/` (see `deploy/hetzner/README.md`).

## 1. Components

```
 Partner browser            K Line browser             Partner ERP             Factory system (MES)
 (React app)                (React app, /console)      (Bearer key)            (Bearer service key)
      |                           |                        |                          |
      | HTTPS, session cookie     | HTTPS, session cookie  | /api/v1                  | /api/mes/v1
      v                           v                        v                          v
 +---------------------------------------------------------------------------------------------+
 |  Reverse proxy (TLS, TRUST_PROXY) -> API process (Fastify 5, Node 22)                       |
 |    helmet + CSP, rate limit, auth hook (session or key), CSRF hook, routes, services        |
 |    serves the built web app (single page fallback)                                          |
 +------+--------------------+--------------------------+-------------------+----------------+
        |                    |                          |                   |
        v                    v                          v                   v
 PostgreSQL 16         Object storage             ClamAV (clamd)       SMTP server
 role kph_app          encrypted chunks           INSTREAM over TCP    (production only)
 row level security    (local disk or S3)
        ^
        | jobs table (FOR UPDATE SKIP LOCKED)
 +------+------------------------------------------------------------------------------+
 |  Worker process (same image, dist/worker.js; in development inside the API)           |
 |    file.process  email.send  notify.kline  notify.push  notice.flush  bulk.push       |
 |    portal.sync   retention   webhook.deliver                                          |
 +------+---------------------------+----------------------------+----------------------+
        |                           |                            |
        v                           v                            v
 K Line customer portal      Partner webhook endpoints     Partners' and staff mailboxes
 API v2.6 (direct cases)     (signed POST, https only)
```

One image, three entry points: `dist/index.js` (API), `dist/worker.js` (worker) and `dist/cli.js` (maintenance). With `RUN_WORKER=true` the API starts the worker lanes inside its own process. This is the development default. In production run the worker as its own process.

### Web app

React 18, react-router-dom 7, TanStack Query 5, three.js for the 3D viewer, `fflate` for zip reading in the browser. The app is built by Vite and served by the API. Fonts are self hosted. The browser makes no third party requests (the CSP would block them). Routes are in `web/src/main.tsx`:

| Area | Routes |
|---|---|
| Public | `/login`, `/mfa`, `/mfa-setup`, `/forgot-password`, `/reset-password`, `/invite/:token`, `/register`, `/verify`, `/privacy` |
| Partner (`/portal`) | `send`, `send/bulk`, `send/bulk/batch/:id`, `cases`, `cases/:id`, `cases/:id/claim`, `claims`, `claims/:id`, `spec`, `spec/:id`, `materials`, `company`, `team`, `account`, `access-log`, `integrations`, `settings/portal-api`, `settings/bags` |
| K Line (`/console`) | `intake`, `cases`, `cases/:id`, `claims`, `claims/:id`, `specs`, `specs/:orgId`, `specs/:orgId/:id`, `materials`, `partners`, `partners/:id`, `mes`, `service-keys`, `staff`, `sites`, `audit`, `account` |

**Menu visibility (visibility only).** `organizations.settings.menu = {claims, spec, materials}` (`admins` or `everyone`, missing means `admins`) decides whether non administrators of a partner company see the optional items Quality claims, Production spec and Materials. `GET /api/org` returns the caller's resolved `menu` booleans (administrators and K Line staff always `true`); `GET` and `PUT /api/org/menu` read and change the raw setting (`org.edit`, partner users only, audited as `org.menu_changed`). The shell, route guards (`Guard menu=...`, redirect to `/portal`), case page links and the notification bell use it. Server permissions and route guards are unchanged by it.

Uploads are prepared in the browser. Dropped folders and zips are read client side, grouped into cases with `shared/filenames.ts`, and uploaded file by file in 8 MB chunks, each with a SHA-256. The server never unpacks an archive.

## 2. Tenancy and row level security

Two organisation kinds exist: `kline` (exactly one, enforced by a unique index) and `partner`. Every user belongs to one organisation.

Isolation is applied twice.

1. **Application code.** Every route checks the caller's permissions (`shared/roles.ts`) and scopes its queries to the caller's organisation. K Line production staff tied to sites are further limited to cases at their sites (`services/scope.ts`).
2. **PostgreSQL row level security.** Every database call goes through `tx(ctx, fn)` in `server/src/db/index.ts`. It opens one transaction and first runs `set_config('kph.org_id', ...)` and `set_config('kph.bypass', ...)`. The functions `kph_bypass()`, `kph_org()` and `kph_can_access(org_id)` read those settings. The policy `tenant_isolation` (`USING` and `WITH CHECK kph_can_access(org_id)`) is on every tenant table, and `FORCE ROW LEVEL SECURITY` applies it to the table owner too.

Context values:

| Caller | `kph.org_id` | `kph.bypass` |
|---|---|---|
| Partner user or partner API key | the partner's organisation id | false |
| K Line user or service key | the K Line organisation id | true |
| System jobs and public routes (`SYSTEM`) | empty | true |

The application connects as `kph_app`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, owns no table, password of at least 16 characters. The migration runner (`db/migrate.ts`) creates or updates this role from `DATABASE_URL` and grants DML on all tables except the audit tables. `kph_owner` is used only for migrations and the command line tool (`DATABASE_OWNER_URL`).

Special policies:

* `kline_only` (bypass required) on `oidc_flows`, `mes_stage_map`, `mes_events`, `dev_mailbox`, `counters`, `job_runs`, `signup_attempts`, `signup_mail_log`.
* `sites` are readable by everyone and writable only with bypass.
* `audit_log` is readable per organisation, insertable, and deletable only inside the trim function. `audit_anchor` is bypass only and has no grant for `kph_app`.

Some code runs as the system on behalf of a partner request (for example a notification to K Line staff). Because partner requests cannot write K Line rows, such work goes through a worker job (`notify.push`, `notify.kline`) that runs as `SYSTEM`.

## 3. Job queue

Jobs live in the `jobs` table. `enqueue(c, kind, payload)` inserts inside the caller's transaction, so a job exists only if the surrounding change commits. Payloads hold ids and references, never patient data.

The worker (`worker.ts`) runs `JOB_CONCURRENCY` independent lanes (default 4, at most 8). A lane claims one due job with `FOR UPDATE SKIP LOCKED`, marks it running and runs the handler. On failure it retries with backoff: 30 s, 1 min, 2 min, 4 min and so on, capped at one hour, until `max_attempts` (default 6), then the job is `failed`. A job running for more than 10 minutes is taken back. Finished `email.send` jobs have their payload wiped (it may hold one time links).

| Kind | Purpose |
|---|---|
| `file.process` | Decrypt the stored file in a stream, scan with ClamAV, validate content, record the result and recompute the case checks. |
| `email.send` | Send one email through SMTP (development: store in `dev_mailbox`). |
| `notify.kline`, `notify.push` | Write in app notifications for K Line staff from partner requests. |
| `notice.flush` | Send the newest held back email notice after the 15 minute window. |
| `bulk.push` | Push a direct manufacturing case to the K Line customer portal. 5 attempts. |
| `portal.sync` | Read portal status for pushed direct cases. |
| `retention` | Daily clean up (section 10). |
| `webhook.deliver` | One delivery attempt to a partner endpoint. |

Scheduling inside the worker: the retention job is queued when the last run is older than 24 hours (checked hourly, claim in `job_runs`). The portal sync is queued every 10 minutes. A sweep every minute re-queues due webhook deliveries whose job got lost.

## 4. Storage and encryption

**Files.** Each file gets a random 32 byte data key and an 8 byte random nonce prefix. The content is cut into 8 MB chunks. Each chunk is sealed with AES-256-GCM. The nonce is the prefix plus the chunk index. The additional data is `chunk|<fileId>|<idx>|<count>`, so a chunk cannot be moved, swapped, or dropped from the end without detection. The data key is wrapped (AES-256-GCM, additional data `key|<fileId>`) with a key encryption key derived by HKDF-SHA256 from `MASTER_KEYS[ACTIVE_KEY_ID]`. The key id is stored with the file so old files stay readable after a rotation.

Only ciphertext reaches the storage. Storage keys are opaque (`f/<32 hex>/<chunk index>`). Original file names are kept only as encrypted fields (`files.name_enc`). Downloads are decrypted on the fly, verified chunk by chunk, and served with `Content-Disposition: attachment`, `nosniff`, `no-store` and a sandbox CSP. No public or presigned URLs exist.

**Fields.** Patient names, instructions, file names, TOTP secrets, webhook secrets and the portal API key are encrypted as `f1.<keyId>.<iv>.<ciphertext>.<tag>` (AES-256-GCM, HKDF sub key for purpose `field`). The additional data binds the value to its row and column: `case|<id>|patient`, `case|<id>|patient_first`, `case|<id>|patient_last`, `case|<id>|notes`, `file|<id>`, `user|<id>|totp`, `webhook|<id>`, `org|<orgId>|portal_api_key`.

**Blind index.** Exact patient name search uses an HMAC-SHA256 of the normalised name (case, accents, spaces and punctuation removed). The key is `BLIND_INDEX_KEY_ID`. Direct cases store both name orders.

**Key rotation.** Add a key to `MASTER_KEYS`, point `ACTIVE_KEY_ID` at it, restart, then run `cli rewrap` (see `SECURITY.md`). It re-wraps file data keys and re-encrypts fields in batches and verifies a sample with only the active key. Keyed hashes that cannot be recreated (API keys, recovery codes, CSRF) use `HASH_KEY_ID`, which stays put.

**Replacement and rework cases** copy the parent's file rows and point at the same stored bytes (`files.cipher_file_id`). Nothing is uploaded or stored twice. Retention removes a stored object only when no live file still points at it.

**Drivers.** `STORAGE_DRIVER=fs` (development) writes `*.bin` files under `STORAGE_DIR`. `s3` uses any S3 compatible store (`S3_ENDPOINT`, `S3_BUCKET`, path style by default).

## 5. Case lifecycle and the four step progress bar

Statuses: `draft`, `submitted`, `on_hold`, `ready`, `received`, `in_production`, `shipped`, `delivered`, `cancelled`.

```
draft --submit--> submitted --route (or automatic)--> ready --MES ack--> received --> in_production --> shipped --> delivered
  ^                   |  ^                               |                    |
  |                   v  |                               v                    v
  +------ fix files on_hold <---- hold (K Line, MES) ----+--------------------+
cancelled: by the partner from draft, submitted, on_hold or ready; by a factory CANCEL event until the case ships
```

Rules that matter:

* **Checks.** Errors block submitting. Warnings need `acknowledgeWarnings`, which is stored with the case. See the brief, section 8, for the list.
* **Submit.** Needs an active organisation with a valid DPA on file. The active production specification is attached (`spec_id`). With the organisation setting `manual_review` the case becomes `submitted` and K Line routes it. Otherwise it becomes `ready` at the default site, or the first site that passes the transfer gate (`resolveRouting`). Due date is `sla_days` (default 3) business days later.
* **Transfer gate** (`shared/geo.ts`, `canReceive`): a partner outside the EEA is not restricted. A partner in the EEA, or with an unknown country, may only have cases produced at a site in the EEA, at a site in an adequacy country, or at any site when a valid SCC agreement is on file. Otherwise `403 transfer_blocked`. See `docs/gdpr/TRANSFERS.md`.
* **After ready**, the stage moves only through the stage engine (`services/stageEngine.ts`): factory events, a CSV import of events, or a manual update by K Line staff with `stage.manual`. Stages only move forward. `shipped` needs carrier, tracking number and aligners shipped, and `delivered` is only accepted for a case that has shipped (`DELIVERED` before `SHIP` is ignored with "Send SHIP before DELIVERED."). An event time long before the case existed (more than 24 hours before its creation) or older than 3 years is an error ("The time is not plausible for this case."); a time in the future is treated as now.
* **Hold** (from submitted, ready, received, in production): the reason is visible to the partner. The partner can fix files and submit again (event `resubmitted`), or K Line can release the case back to `submitted`. Submitting again from a hold always puts the case back to `submitted` for a manual K Line review, whatever the partner's review setting, so a partner can never push a held case straight back into production; K Line then routes it (`ready`).
* **Cancel:** sets `purge_after` to 30 days later.

### Factory stages and the four step bar

The factory stages, in order, are `received`, `printing`, `thermoforming`, `trimming`, `finishing`, `quality_check`, `packing`, `shipped`, `delivered`. Partners see only four steps (`shared/stages.ts`, `stepperSteps`).

| Hub status | Progress bar step | Caption on the current step |
|---|---|---|
| `draft` | Draft | none |
| `submitted` | Submitted | none (or the portal's own wording for a direct case) |
| `on_hold` | Submitted | On hold |
| `ready` | Submitted | Files checked |
| `received`, `in_production` | Production | the factory stage, for example "3D printing" |
| `shipped` | Shipped | none |
| `delivered` | Shipped | Delivered |
| `cancelled` | no current step, a Cancelled notice | none |

Steps before the current one are done. The caption is computed in `stepperSteps`.

## 6. Standard and direct manufacturing flows

| | Standard ("Send files") | Direct manufacturing |
|---|---|---|
| Created by | Folder drop or zip, one case per folder; or the partner API | Zip of case folders named `<patient id> <first> <last>`; `POST /api/bulk/batches` |
| Patient identity | Optional single name, or a case ID | Patient ID, first name and last name are mandatory (encrypted, `manufacturing_mode = 'direct'`) |
| Who produces | K Line factory via the MES | K Line customer portal (API v2.6) |
| How it reaches production | The MES pulls `GET /api/mes/v1/intake` | The worker job `bulk.push` creates the case in the portal and uploads the files |
| Status source | Factory events (`/api/mes/v1/events`, CSV import, manual) | Portal status sync (`portal.sync`) |
| MES behaviour | Listed in intake; events accepted | Not listed; events are errors (`direct_case`) |
| Replacement order | Allowed for shipped or delivered cases | Refused (`409 direct_case`); a rework after an accepted claim is created as a standard case |

### Direct manufacturing push

When a direct case is submitted its `portal_push` becomes `pending` and a `bulk.push` job is queued. The job (`services/bulkPush.ts`), with the organisation's own portal credentials (`organizations.settings.portal_api`, key encrypted):

1. `POST /cases` with first and last name, `gender` (the organisation's default, else 2 "Prefer not to say"), `product_type` 0 and the instructions. The portal case uuid is stored at once.
2. Uploads PDFs and images one by one to `field_case_other_docs`, then every other file (STL, PTS, CSV and so on) in one zip `<ref>-files.zip` with a `manifest.csv`, to the same field.
3. `PATCH /cases/{uuid}/submit`.

The job is resumable: finished uploads are recorded. Permanent errors (4xx) fail at once, temporary ones after the last attempt. `portal.lastError` is fixed text and never contains patient or portal text. On success `purge_after` is set to the push time plus the partner's retention months.

Without credentials the push fails with a clear message. The in memory fake portal is used only when `PORTAL_FAKE=true` (refused in production). Such cases show `portal.demo: true` and are never synced.

### Portal status sync

`portal.sync` runs every 10 minutes (and on demand: `cli portal-sync`, or the Refresh button `POST /api/cases/:id/portal/refresh`). For pushed, non demo direct cases that have not shipped, it reads the portal case. `InProduction` moves the Hub case to `in_production` (stage empty). `Shipped` moves it to `shipped` and records carrier and tracking from the portal's `tracking_number`. The expected shipping date becomes the due date. Statuses only move forward, and each change adds a case event with source "K Line portal", notifies the partner and emits webhooks. Up to 200 cases are checked per run, least recently checked first.

## 7. MES integration

The factory system is the source of truth for production. The Hub offers `/api/mes/v1` with service keys (scopes `mes:intake`, `mes:files`, `mes:events`). The full guide is `docs/integration/MES_INTEGRATION.md`.

* `GET /intake` lists standard cases in status `ready`, oldest first, with canonical file names, checksums, bag label content and the instructions. Patient names and partner file names are never sent.
* `GET /files/:id` streams a decrypted file. The factory must verify the SHA-256.
* `POST /cases/:ref/ack` moves `ready` to `received` and stores the factory's case number.
* `POST /events` reports stages, holds, cancellations and shipments. It is idempotent on `event_id`. Codes are translated by the stage map (`mes_stage_map`), which K Line edits in the console.
* K Line staff can import events from a CSV when the factory system cannot call the API.
* Every read or download by a service key is written to the partner's access log as "K Line service".

## 8. Webhooks outbox

Partners register https endpoints (up to 10). Events: `case.submitted`, `case.on_hold`, `case.received`, `case.stage_changed`, `case.shipped`, `case.delivered`, `case.cancelled`, `claim.updated`, `materials.low_stock`, `spec.updated`.

`emitCaseWebhook` and its siblings (`services/webhooks.ts`) insert one `webhook_deliveries` row and queue one `webhook.deliver` job per subscribed endpoint inside the transaction that changes the business data, so a rolled back change leaves nothing behind. Payloads hold references and counts only and are limited to 64 KB.

Delivery (`services/webhookDelivery.ts`): `POST` with `x-kph-signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`, a 10 second limit, redirects not followed. Retries after 1, 5, 30, 120, 360, 720 and 1440 minutes (8 attempts), then `dead`. After 25 failed attempts in a row the endpoint is switched off and the administrators are told. Addresses are checked when saved and again at connect time (`services/netSafety.ts`) to block private, loopback, link local and metadata addresses, including DNS rebinding. Deliveries are deleted after 90 days.

## 9. Audit log

`audit_log` is append only and hash chained. `kph_audit_append` (SECURITY DEFINER) takes a lock on `audit_anchor`, computes `hash = sha256(prev_hash || canonical entry)` and inserts. The application role can only read entries of its own organisation and execute the append function. `kph_audit_verify` walks the chain from the last trim anchor. `kph_audit_trim` removes a prefix older than a cut off and moves the anchor, so the chain still verifies. A trigger blocks any other update, delete or truncate, even for the owner. Verification is available in the console (`GET /api/audit/verify`, `kl_admin` only) and on the command line (`audit-verify`).

## 10. Retention (as implemented in `services/retention.ts`)

The daily job removes, in this order: cases due for purge, leftover objects, old drafts, abandoned uploads, unconfirmed registrations, declined registrations, unused logos, then old rows in bookkeeping tables. The schedule, with periods, is in `docs/gdpr/RETENTION.md`. The audit log is never touched by the job. It is trimmed only by `cli audit-trim`, which is not scheduled.

## 11. Configuration variables

Read from the environment and validated by zod in `server/src/config.ts`. In development `server/.env` is loaded and never overrides real environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `HOST` | `127.0.0.1` | Listen address. |
| `PORT` | `4000` | Listen port. |
| `PUBLIC_URL` | `http://localhost:4000` | Base URL used in emails and links. Must be https in production. |
| `TRUST_PROXY` | `false` | `true`, `false`, a hop count, or a comma separated list of addresses, CIDR ranges and the names `loopback`, `linklocal`, `uniquelocal`, for the real client IP behind a proxy or tunnel (for cloudflared on the same computer: `loopback`). Anything else stops the server from starting. |
| `DATABASE_URL` | required | Connection as `kph_app`. Password at least 16 characters. |
| `DATABASE_OWNER_URL` | none | Connection as `kph_owner`, for migrations and the command line tool. |
| `MASTER_KEYS` | required | JSON object of key id to 32 byte base64 key. |
| `ACTIVE_KEY_ID` | required | Key id used for new wraps and encryptions. Must be in `MASTER_KEYS`. |
| `BLIND_INDEX_KEY_ID` | required | Key id for the name blind index. Must be in `MASTER_KEYS`. |
| `HASH_KEY_ID` | `BLIND_INDEX_KEY_ID` | Key id for keyed hashes that cannot be recreated (API keys, recovery codes, CSRF tokens). Does not change when `ACTIVE_KEY_ID` rotates. Must be in `MASTER_KEYS`. |
| `STORAGE_DRIVER` | `fs` | `fs` or `s3`. |
| `STORAGE_DIR` | `server/data/files` | Directory for the `fs` driver. |
| `S3_ENDPOINT`, `S3_BUCKET` | none | Required for `s3` in production. |
| `S3_REGION` | `eu-central-1` | |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | |
| `S3_FORCE_PATH_STYLE` | `true` | |
| `SCANNER` | `clamav` | `clamav` or `none`. |
| `CLAMAV_HOST`, `CLAMAV_PORT` | `127.0.0.1`, `3310` | clamd address. |
| `SMTP_URL` | none | Required in production. Without it development mail goes to `dev_mailbox`. |
| `MAIL_FROM` | `Portal Hub <no-reply@localhost>` | Sender address. |
| `SESSION_IDLE_MINUTES` | `30` | Idle session timeout. |
| `SESSION_MAX_HOURS` | `12` | Absolute session lifetime. |
| `STEP_UP_MINUTES` | `10` | How long a fresh authenticator code counts. |
| `SCRYPT_LOG_N` | `17` | Password hashing cost (N = 2^value). At least 15 in production. |
| `SIGNUP_ENABLED` | `false` | Open self registration. |
| `SIGNUP_DAILY_LIMIT` | `100` | Registration attempts per rolling 24 hours. |
| `SIGNUP_MIN_MS` | `600` | Minimum time of every registration answer. At least 600 in production when signup is on. |
| `SUPPORT_EMAIL` | `support@localhost` | Shown in emails and the app. |
| `PRIVACY_EMAIL` | `privacy@localhost` | Privacy contact. Required in production when signup is on. |
| `RUN_WORKER` | `false` | Run the worker inside the API process. |
| `DEMO_MODE` | `false` | Demo accounts, dev mailbox. Refused in production. Also answers only for direct local use (no proxy headers, loopback or private peer). |
| `TUNNEL_HOOKS_ONLY` | `false` | Development tunnels: a request with proxy headers (`x-forwarded-for`, `forwarded`, `cf-connecting-ip`, `cf-ray`, `x-real-ip`) is answered 404 unless it is for `/api/hooks/kline-portal/<id>` or `/api/health`. Refused in production. |
| `PORTAL_FAKE` | `false` | In memory portal for organisations without credentials. Refused in production. |
| `ALLOW_NO_SCANNER` | `false` | Allows `SCANNER=none` in production. |
| `AUDIT_RETENTION_MONTHS` | `36` | Default for `cli audit-trim`. |
| `WEB_DIST` | `web/dist` | Built web app directory. |
| `LOG_LEVEL` | `info` (`silent` in tests) | Log level. |
| `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET` | none | Both together switch on Google sign in for K Line staff. |
| `OIDC_ALLOWED_DOMAIN` | none | Workspace domain (for example `example.com`) that staff accounts must belong to. Required when Google sign in is on. |
| `OIDC_REQUIRE_LOCAL_MFA` | `true` | Cannot be turned off. Google is only the first factor and the authenticator code is always required (two factor sign in for everyone). Any value but `true` stops the server from starting. |
| `OIDC_GOOGLE_DISCOVERY_URL` | Google's discovery document | Only tests and proxies change it. Must be https in production. |
| `JOB_CONCURRENCY` | `4` | Read directly by the worker. Between 1 and 8. |

Production refuses to start when: `PUBLIC_URL` is not https; `DEMO_MODE`, `PORTAL_FAKE` or `TUNNEL_HOOKS_ONLY` is on; `SCANNER=none` without `ALLOW_NO_SCANNER`; `SMTP_URL` is missing; the `s3` driver lacks a bucket or endpoint; signup is on without `PRIVACY_EMAIL` or with `SIGNUP_MIN_MS` below 600; `SCRYPT_LOG_N` is below 15; Google sign in uses a discovery address that is not https. In every environment it refuses a `DATABASE_URL` password shorter than 16 characters, key ids (`ACTIVE_KEY_ID`, `BLIND_INDEX_KEY_ID`, `HASH_KEY_ID`) that are not in `MASTER_KEYS`, and an incomplete Google sign in configuration.

## 12. Directory map

```
shared/
  roles.ts      roles, permissions, API scopes
  stages.ts     statuses, factory stages, four step bar, portal status mapping, default stage map
  filenames.ts  file and folder name parsing, case grouping
  bulk.ts       direct manufacturing folder names
  bag.ts        bag label layout and rendering
  spec.ts       specification content, canonical JSON, hashing, diff
  defects.ts    claim defect codes and statuses
  signup.ts     registration validation, countries, throwaway domains
  geo.ts        EEA and adequacy lists, transfer gate
server/
  migrations/   001_init, 002_intake, 003_production, 004_quality_specs_materials, 005_signup_profile, 006_integrations, 007_oidc, 008_portal_hooks, 009_erasure_scrub_jobs
  src/
    app.ts config.ts index.ts worker.ts cli.ts jobs.ts handlers.ts audit.ts
    db/          pool, tx(), migration runner
    auth/        context (guards), sessions, apikeys, oidc (Google sign in protocol)
    crypto/      envelope (files), keys (fields, HMAC, blind index), password, totp, tokens
    http/        errors, util (parse, redaction)
    storage/     fs and S3 drivers
    routes/      one module per area (auth, cases, uploads, files, bulk, console, mes, admin, partners, claims, specs, materials, org, orgPortal, profile, signup, apiKeys, webhooks, exports, account, notifications, bags, audit, demo, oidc, v1)
    services/    business logic (cases, files, checks, validate/*, stageEngine, mes, intake, bulk, bulkPush, portal/*, portalSync, claims, childCases, specs, materials, webhooks, webhookDelivery, netSafety, notify, mail, exports, retention, signup, profile, partnerReview, team, org, scanner, rewrap)
    demo/        seed, seedCases (Acme demo data set), assets (synthetic STL, PTS, PDF and sample folders)
  test/          vitest unit and integration tests
web/
  src/           main.tsx, layout/, lib/ (api client, upload engine, intake), ui/, viewer/, pages/partner, pages/console, pages/auth
deploy/          docker-compose.dev.yml; docker-compose.prod.yml, Caddyfile, clamd.conf; hetzner/ (README, env examples, backup.sh, restore-test.sh)
Dockerfile       one image, three entry points
docs/            briefs, contracts, guides
```

## 13. Portal webhook receiver (instant updates)

The K Line portal can call a public address of the Hub when a case changes. Full description: `docs/integration/PORTAL_WEBHOOK.md`.

* Table `portal_hooks` (migration `008_portal_hooks.sql`): one row per partner company with the public `hook_id`, the secret token as a field encrypted value (AAD `org|<org id>|portal_hook`), and counters (`last_received_at`, `received_count`, `last_result`). Row level security as for every tenant table.
* Public route `POST /api/hooks/kline-portal/:hookId` (`routes/portalHooks.ts`, `services/portalHooks.ts`): no session, no CSRF, secret in `X-KLINE-SECRET-TOKEN`, 256 KB body limit, 120 requests a minute per IP and 600 per receiver. Unknown address 404, wrong secret 401, everything else 200.
* A message is only a reminder. For a `case` message whose uuid matches an open direct case of the same company, the job `portal.sync.case` (payload: the case id only) is queued, one at a time per case. The job calls `runPortalSync({ caseId })`, so the status always comes from the portal API and never from the message. The 10 minute `portal.sync` stays as the backup.
* Management routes on `GET/POST/DELETE /api/org/portal-api[/webhook]` (`routes/orgPortal.ts`), and the card on the Portal connection page (`web/src/pages/partner/PortalWebhookCard.tsx`).

**Case address per user.** `organizations.settings.case_address` is the company default; `users.case_address` (migration 010, nullable jsonb, tenant isolated by the existing row level security on `users`) is a person's own address. `GET|PUT|DELETE /api/account/case-address` act on the caller only. A direct case is pushed with the address of its creator (`cases.created_by`) when complete, else the company address (`services/userCaseAddress.ts`); `portal_push.addressSource` records `own` or `company` and never a value.
