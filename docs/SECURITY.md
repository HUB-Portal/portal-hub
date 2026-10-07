# Security

Last checked against the code: 6 Oct 2026.

This document lists the security controls of the Portal Hub, where each one lives in the code, what is known to be missing, and how to report a problem. It describes the software. It is not a certification, an audit report or legal advice. No independent penetration test has been done yet (see section 17).

The deployment files are in `deploy/` and the guide is `deploy/hetzner/README.md`. Whatever is marked "to confirm" must be checked on the real server.

## 1. Principles

* Patient data stays out of logs, emails, webhooks, URLs, file names on disk and error messages.
* Two independent layers protect tenant data: application code and PostgreSQL row level security.
* Sensitive data is encrypted with keys that are not in the database.
* Everything security relevant is written to a tamper evident audit log that partners can read for their own organisation.
* Never weaken a control to make a demo easier. Demo helpers exist only when `DEMO_MODE=true`, which production refuses.

## 2. Authentication

| Control | Implementation | Code |
|---|---|---|
| Password plus authenticator app for everyone | Password sign in creates a partial session. Data is unreachable until a TOTP code (or a recovery code) promotes it to `full`. | `routes/auth.ts`, `auth/context.ts` (`guard`, `requireFull`) |
| Password hashing | scrypt, `r=8`, `p=1`, N = 2^`SCRYPT_LOG_N` (default 17, at least 15 in production), random 16 byte salt, NFKC normalised. | `crypto/password.ts` |
| Password policy | 12 to 128 characters. Before a password is compared with the list of about 1,000 common passwords it is normalised (lower case, letters standing in for symbols and digits such as `P@ssw0rd`, symbols dropped, digits at the start and end cut off), so a common word with any tail (`Password12345678`, `Admin@123456789`) is refused. Also refused: four or more sequential characters (`abcd`, `4321`) or keyboard row runs in either direction (`qwer`, `asdf`, English, German and French rows, `1qaz2wsx`), the same character four times or a short block repeated, a password of one kind of character under 16 characters, one of the person's email name or name parts, and (on a password change) the same password as the current one. The messages are friendly and generic. | `checkPasswordPolicy` |
| No account enumeration at sign in | The same message and similar timing for unknown, disabled, locked and wrong password cases. A dummy scrypt check runs for unknown accounts and answers are padded to 250 ms. | `routes/auth.ts` (`dummyVerify`, `padTo`) |
| Lockout | 5 wrong passwords lock the account for 15 minutes. Each repeat doubles the time, up to 24 hours. A correct sign in resets the password counter. | `routes/auth.ts` |
| TOTP | RFC 6238: SHA-1, 30 seconds, 6 digits, one step either side. All three steps are compared so timing does not show which one matched. The last used step is stored and older or equal steps are refused (replay protection). | `crypto/totp.ts`, `checkTotp` |
| TOTP secret storage | Field encrypted, additional data `user|<id>|totp`. | `crypto/keys.ts` |
| Wrong code limit | Wrong authenticator codes and wrong recovery codes (also wrong step up codes) are counted **per person across all sessions**: five within 15 minutes lock the account (`users.locked_until`, 15 minutes, doubling on every repeat up to 24 hours) and end every session of the person. A new password sign in never gives fresh guesses, and a correct password never resets this counter: only a correct authenticator code, an administrator unlock or a password reset by email link does (columns `mfa_failed_codes`, `mfa_fail_window_start`, `mfa_lockout_count`, migration 011). A locked account cannot finish a sign in. The session itself also ends after five wrong codes. | `auth/sessions.ts` (`recordUserMfaFailure`, `recordMfaFailure`), `routes/auth.ts` (`failMfa`) |
| Recovery codes | Ten one time codes, stored only as keyed hashes (HMAC-SHA256). A used code is removed. Regenerating needs step up. | `crypto/totp.ts`, `routes/auth.ts` |
| Password reset and invitations | One time tokens of 256 bits, only the SHA-256 is stored. Reset links last 60 minutes, invitations 7 days, registration confirmations 48 hours. Using a link retires earlier links of the same kind. Completing a reset or an invitation revokes the person's other sessions. A reset also lifts any lock and clears the wrong password and wrong code counters. The reset request always answers the same text. | `services/userTokens.ts`, `routes/auth.ts` |
| Google sign in for K Line staff (optional) | Off unless `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET` and `OIDC_ALLOWED_DOMAIN` are all set. OpenID Connect authorisation code flow with PKCE (S256), scopes `openid email`, and the hosted domain requested. The flow row stores only hashes of the state and nonce, the PKCE verifier field encrypted, and a hash of a short lived cookie that binds the flow to the browser that started it. A flow is used once and expires after 10 minutes. The ID token must be RS256 (no other algorithm is accepted), verified against Google's key set (at least 2048 bits), with the right issuer, audience, expiry, nonce, `email_verified` and `hd` claim, and the address must end with the allowed domain. Only an existing K Line staff account can sign in this way (partner users never can, and nothing creates accounts). The Google account id (`sub`) is stored at the first sign in and must match afterwards (unique index). Every failure sends the browser to `/login?error=google` with no detail and writes `auth.oidc_failed` with a reason code. | `auth/oidc.ts`, `routes/oidc.ts`, `migrations/007_oidc.sql` |
| Switch for two factor sign in | `MFA_REQUIRED` (default `true`). Only an explicit `false`, `0`, `no` or `off` turns it off; a typo keeps it on. Off means a password (or Google) gives a full session, nobody is asked to set up an authenticator, and sensitive actions no longer ask for a code. The server logs a warning at start. Temporary: turn it on again before real use. | 
| Authenticator after Google | Two factor sign in is required for everyone (fixed decision 4). Google is only the first factor: the callback always creates a session at stage `password` (or `mfa_setup` when no authenticator is set up yet), never `full`, and the person still enters an authenticator code. There is no setting to change this. `OIDC_REQUIRE_LOCAL_MFA` is accepted only as `true` (or left out); any other value stops the server from starting in every environment ("two factor sign in is required for everyone"). | `routes/oidc.ts`, `config.ts` |

Not implemented: WebAuthn or other phishing resistant factors, and checking passwords against an external breach list.

## 3. Sessions and CSRF

| Control | Implementation | Code |
|---|---|---|
| Server side sessions | A 256 bit random token in an `HttpOnly`, `SameSite=Strict` cookie: `__Host-kph_session` with `Secure` in production, `kph_session` in development. Only the SHA-256 of the token is stored. | `auth/sessions.ts`, `config.ts` (`cookieName`) |
| Lifetimes | Idle 30 minutes (`SESSION_IDLE_MINUTES`), absolute 12 hours (`SESSION_MAX_HOURS`). | `loadSession` |
| Token rotation | The token is replaced whenever the session moves to a new stage (password, setup, full), which prevents fixation. | `promoteSession` |
| Revocation | On logout, password change or reset, role change, disabling, authenticator reset, suspension of the company, and five wrong codes. A disabled user or suspended company fails at the next request. | `auth/sessions.ts`, `services/team.ts` |
| Session list | People see their active sessions and can revoke one or all others. | `routes/auth.ts` |
| CSRF | Every write (`POST`, `PUT`, `PATCH`, `DELETE`) with a session needs the header `x-csrf-token`, the HMAC-SHA256 of the session id. It is compared in constant time. Exempt: sign in, password forgot and reset, invitation accept, registration and confirmation (there is no session yet). API keys use no cookie and need no CSRF token. | `app.ts` (`CSRF_EXEMPT`), `crypto/tokens.ts` |
| Step up | Sensitive actions need a TOTP code within the last `STEP_UP_MINUTES` (10), else `403 step_up_required`. | `requireStepUp`, `guard({ stepUp: true })` |

Actions that need step up: unlocking a locked person (`POST /api/team/:id/unlock`, `POST /api/staff/:id/unlock`, audited as `team.unlocked` and `staff.unlocked`); replacing the factory stage map; creating or revoking API keys; creating, changing, rotating and deleting webhooks; saving the K Line portal connection; inviting team members, changing roles and resetting an authenticator (partners and K Line staff); creating or revoking service keys; adding or withdrawing agreements; adding and inviting partners and declining registrations; proposing, signing and rejecting specifications; regenerating recovery codes; exporting with patient names; saving a bag layout that prints personal data; erasing a case on request.

## 4. Authorisation

* Ten roles (five partner, five K Line) map to 28 permissions in `shared/roles.ts`. The server enforces them with `guard({ permission })` on every route. The web app hides what a person cannot do, but the server is the authority.
* Routes are closed to API keys unless a route says otherwise (`guard({ apiKey: true })`).
* K Line only routes answer `403` to partner users even when they hold the permission name (partner administrators hold `audit.read` and `file.download`). Service keys never work on partner routes, and partner keys never work on K Line or factory routes.
* K Line production staff tied to sites see only cases routed to those sites (`services/scope.ts`). Outside the scope a case reads as `404`.
* A partner can never reach another partner's rows: application checks plus row level security (section 7).
* **Menu visibility is visibility only.** Partner administrators (permission `org.edit`) choose in `organizations.settings.menu` (`PUT /api/org/menu`, audited as `org.menu_changed`) whether the optional menu items Quality claims, Production spec and Materials are shown to the other people of their company. `GET /api/org` returns what the caller sees as `menu`. The setting only drives the web app (sidebar, links, route redirects). It does not change any role permission or route guard: a person whose role allows a server route can still call it, and a person whose role does not still gets `403`. Nobody gets access through this setting.
* The last active administrator of an organisation cannot be disabled or demoted, and people cannot change their own roles or disable themselves (`services/team.ts`).

## 5. Encryption

| Control | Implementation | Code |
|---|---|---|
| Files | Per file random 32 byte key, 8 MB chunks, AES-256-GCM, nonce = 8 random bytes plus chunk index, additional data `chunk|<fileId>|<idx>|<count>`. Tampering, swapping, reordering and truncation fail. | `crypto/envelope.ts` |
| Key wrapping | The data key is wrapped under an HKDF-SHA256 derived key from `MASTER_KEYS[ACTIVE_KEY_ID]`. The key id is stored with the file. | `wrapDataKey` |
| Fields | `f1.<keyId>.<iv>.<ciphertext>.<tag>`, AES-256-GCM, additional data binds row and column. Used for patient names (first, last, combined), instructions, file names, TOTP secrets, webhook secrets and the portal API key. | `crypto/keys.ts` |
| Blind index | HMAC-SHA256 of the normalised name under a separate key (`BLIND_INDEX_KEY_ID`). | `blindIndex` |
| Keys outside the database | Master keys come from the environment (`MASTER_KEYS`). The database never holds them. Keys are validated at start (32 bytes, ids present). | `config.ts` |
| Rotation | `gen-key` prints a new key. `ACTIVE_KEY_ID` selects the key for new data. Old data keeps its key id and stays readable as long as the old key stays in `MASTER_KEYS`. `cli rewrap` moves existing data to the active key: file data keys, patient names (full, first, last), instructions (plain text from before encryption existed is encrypted too), original file names, authenticator secrets, webhook secrets, portal API keys, and the name blind indexes when `BLIND_INDEX_KEY_ID` has changed. It works in batches (one transaction each), can be stopped and started again, supports `--dry-run`, `--only KIND[,KIND]` and `--batch N`, never prints a secret or value, and finishes with a check that decrypts a sample of every kind using only the active key. It exits with code 1 when any row failed. | `services/rewrap.ts`, `cli.ts` |
| Keys for hashes that cannot be recreated | Keyed hashes of API keys and recovery codes, and the CSRF key, use `HASH_KEY_ID` (default: `BLIND_INDEX_KEY_ID`), which does not rotate with `ACTIVE_KEY_ID`. Rotating the active key therefore never invalidates customers' API keys or recovery codes. Changing `HASH_KEY_ID` itself would invalidate them. | `crypto/keys.ts` (`stableKeyId`) |
| Transport | TLS is terminated by the reverse proxy. The app sets HSTS (two years, includeSubDomains, preload) in production and `upgrade-insecure-requests` in the CSP. | `app.ts` |
| Storage at rest | Only ciphertext is stored. The disk or bucket should also be encrypted by the host (for example encrypted volumes). This is a deployment task. | `storage/index.ts` |

Rotation procedure (outline; the operator runbook belongs in the deployment guide): take a backup; run `gen-key`; add the new entry to `MASTER_KEYS` and keep the old one; set `ACTIVE_KEY_ID` to the new id; restart the API and worker; run `rewrap --dry-run`, then `rewrap`; check that the report ends with "Everything uses ...", take a fresh verified backup, and only then remove the old key from `MASTER_KEYS`. Test the whole procedure on a copy of the data before using it in production.

## 6. Uploads and malware scanning

| Control | Implementation | Code |
|---|---|---|
| Allowed types by purpose | Case files `stl pts pdf csv svg txt xml json jpg jpeg png`; claim evidence `jpg jpeg png mp4 mov m4v pdf`; shipment documents `pdf jpg jpeg png`; logos `png jpg jpeg svg`; documents `pdf jpg jpeg png`. | `services/files.ts` |
| Executables refused | A list of executable and script extensions is always refused. The first chunk is also checked for executable magic bytes (MZ, ELF, Mach-O, Java class, `#!`) and the upload is removed. | `services/validate/index.ts`, `routes/uploads.ts` |
| Size limits | Case files 512 MB, 600 files per case; claim videos 512 MB, other claim files 50 MB, 40 per claim; shipment documents 25 MB, 20 per shipment; logos 5 MB; documents 50 MB. A company not yet approved may hold 10 profile files. | `services/files.ts` |
| Company logo changes | Every partner role except viewer holds `org.logo` and may upload (purpose `logo`), replace or remove the company logo (`POST` and `DELETE /api/org/logo`). Brand logos, documents and the rest of the profile stay with `org.edit` (administrators). K Line staff and API keys are refused. All logo checks still apply and a refused file is deleted. The replaced logo file is deleted. Each change is audited in the partner's own access log as `org.logo_changed` or `org.logo_removed` with the acting user and the file kind only, and the company administrators get an in app notification (no email, no file name). | `routes/profile.ts`, `services/profile.ts`, `services/files.ts` |
| Integrity in transit | Each 8 MB chunk carries its SHA-256 in `x-chunk-sha256`. A mismatch answers `422 checksum_mismatch`. | `routes/uploads.ts` |
| Malware scan | The worker decrypts the file as a stream and sends it to ClamAV (clamd `INSTREAM` over TCP). An infected file is rejected, its content is removed at once and `file.infected` is audited. | `services/scanner.ts`, `services/files.ts` |
| Fail closed | If the scanner cannot be reached or reports an error, the job retries. After the last attempt the file is rejected with `scan_failed`. Nothing is accepted unscanned (unless `SCANNER=none`, which production refuses without `ALLOW_NO_SCANNER`). | `processFileJob` |
| Active content | PDF: `/JavaScript`, `/JS`, `/Launch` block; embedded files and encryption warn. SVG: scripts, event handlers, `javascript:` links, `foreignObject` and external references block. CSV: cells starting with `= @ + -` followed by text warn (formula injection). Images and videos are checked by magic bytes. | `services/validate/*` |
| Model checks | STL and PTS integrity checks (units, open edges, trim line closure). Edge analysis is capped at 3 million triangles. | `services/validate/stl.ts`, `pts.ts` |
| No server side unpacking | Zips are read in the browser. The server never extracts an archive, so there is no zip slip or zip bomb on the server. | `web/src/lib/zip.ts` |
| Downloads | Decrypted on the fly, verified per chunk, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; sandbox`. No public or presigned URLs. Every download is audited to the owning organisation. | `routes/files.ts` |

## 7. Row level security

* `kph_app` has `NOSUPERUSER NOBYPASSRLS`, owns nothing and cannot alter policies. `FORCE ROW LEVEL SECURITY` is on, so even the table owner is subject to the policies.
* `tx()` sets the organisation and bypass flag in the same transaction as the queries (`set_config(..., true)` is transaction local, so a pooled connection cannot leak a context).
* Tables with an `org_id` use `tenant_isolation`. Bookkeeping tables (`mes_events`, `mes_stage_map`, `job_runs`, `oidc_flows`, `dev_mailbox`, `counters`, signup bookkeeping) are for bypass callers only.
* Tests run against a real PostgreSQL with the restricted role and check that tenants cannot read each other's rows through the API and through the database (`server/test/integration.test.ts` and later phase tests).

## 8. Audit log

* `audit_log` is append only and hash chained: `hash = sha256(prev_hash || canonical entry)`. Entries are written by `kph_audit_append` (SECURITY DEFINER), which locks `audit_anchor` so the chain has no gaps.
* `kph_app` has `SELECT` on `audit_log` (filtered to its organisation), no grant on `audit_anchor` and no update or delete. A trigger blocks update, delete and truncate for everyone except the owner's trim function.
* `kph_audit_verify` walks the chain. The console offers it to `kl_admin` (`GET /api/audit/verify`, 6 per minute) and the command line has `audit-verify`.
* What is recorded: actor type (`user`, `api_key`, `service`, `system`), actor, organisation, action, target, IP, user agent and small details. Details never hold patient names, file names, instruction text or secrets.
* Partners read their own organisation's log, including every K Line access: case views, name reveals and searches, file downloads, package downloads, bag files, claim views and every file the factory system downloads. A poll of the factory intake (`GET /api/mes/v1/intake`) writes **one** entry per call to K Line's own log (`mes.intake_read`: how many cases and up to 20 references, no entry per case), so frequent polling cannot bury the log.
* Retention: `AUDIT_RETENTION_MONTHS` (36) is used by `cli audit-trim`. The worker does not run it, so someone must schedule it.

## 9. API keys, service keys and webhooks

| Control | Implementation | Code |
|---|---|---|
| Key format | `kph_<12 hex prefix>_<43 base64url secret>`. Only a keyed hash of the secret is stored. Shown once. | `auth/apikeys.ts` |
| Scopes | Partner: `cases:read cases:write patients:read claims:read materials:read`. K Line service: `mes:intake mes:files mes:events`. `patients:read` needs `cases:read`. | `shared/roles.ts` |
| Limits | Expiry 1 to 730 days (365 default), up to 20 active keys per company, optional allow list of up to 20 IPv4 or IPv6 addresses or ranges. A wrong, revoked, expired or out of range key gives one answer (`401 invalid_api_key`). | `services/apiKeysAdmin.ts` |
| Separation | `/api/v1` accepts only a Bearer key: the cookie is never read and no CSRF applies. Service keys get `403 wrong_key_type` there. | `app.ts` |
| Usage record | Last use time and address, written at most once a minute. | `authenticateApiKey` |
| Patient names over the API | Only with the `patients:read` scope. Each page or case that reveals names is audited (`case.names_revealed`, `case.name_revealed`). A key without that scope sees no patient field on any route, also the session style ones (`GET /api/cases`, `GET /api/cases/:id`, create, change, submit, child cases and bulk answers): `patientMasked`, `hasPatientName` and the name fields are removed from every JSON answer, and a patient name search finds nothing for such a key. | `services/v1.ts`, `http/patientFields.ts`, `app.ts` (`preSerialization`) |
| Webhook secrets | `whsec_<43 base64url>`, shown once, stored field encrypted, rotatable (the old secret stops at once). | `services/webhookAdmin.ts` |
| Webhook signature | `x-kph-signature: t=<unix>,v1=<HMAC-SHA256("<t>.<raw body>")>`. Receivers should reject timestamps older than 5 minutes. | `services/webhookDelivery.ts` |
| SSRF protection | The address must be https, without credentials, not an internal name and not a private address. The name is resolved at save time and again at connect time, and the connection uses the address the guarded lookup returned (defeats DNS rebinding). Blocked: loopback, private, link local (169.254.169.254), CGNAT, multicast, reserved, documentation, NAT64, 6to4, Teredo and IPv4 embedded in IPv6. Redirects are not followed. The answer body is never stored. The same guard protects the K Line portal base URL. | `services/netSafety.ts`, `services/portal/v2.ts` |
| Payloads | References and counts only, at most 64 KB. No hold reasons, notes, names or claim text. | `services/webhooks.ts` |

## 10. HTTP hardening

Set in `app.ts` with `@fastify/helmet`:

* `Content-Security-Policy`: `default-src 'self'`; `script-src 'self'` (no inline script, no `eval`); `style-src 'self' 'unsafe-inline'` (React sets style attributes); `img-src 'self' data: blob:`; `media-src 'self' blob:`; `font-src 'self'`; `connect-src 'self'`; `worker-src 'self' blob:`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` in production.
* `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
* `Strict-Transport-Security` (two years, includeSubDomains, preload) in production.
* `Cache-Control: no-store` on every `/api` response. Built assets are cached for a year by hashed file name. `index.html` is `no-cache`.
* No third party requests from the browser: no analytics, CDN fonts or external scripts.
* The JSON body limit is 1 MB. Chunk uploads accept `application/octet-stream` up to 8 MB plus 4 KB.
* A NUL character (U+0000) cannot be stored by PostgreSQL. One early check (`preValidation` hook) refuses it in the address, query string, route parameters and body (JSON, nested, keys and values, or text) of every `/api` route with `400 invalid_request` and a friendly message, so it can never become a server error.
* Hidden text direction characters (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) are refused with `400 invalid_text` in file names, specification clause titles and text, names of team and staff members, material names and claim text (summary, description, item notes, messages, decisions). They are allowed in patient names.

## 11. Logging

* Request logs serialise only method, URL, status and IP. Cookies, `Authorization` headers, CSRF tokens and bodies are never logged.
* `redactUrl` hides `token`, `t`, `code` and `state` query values, the segment after `/invite/` (except `accept`), `/api/auth/verify/<token>`, `/api/v1/cases/<key>` and `/api/v1/files/<key>` segments that are not case references or UUIDs, and the values of `search` and `case_id`.
* Error responses carry fixed text. Server errors log a short error message without a stack trace in production.
* Job errors are cut to 300 characters and are never expected to hold patient data. Email addresses and links are removed from every job error, and failed email jobs keep one fixed sentence (plus a numeric SMTP code). Portal and webhook errors are fixed wording.
* Every `/api` answer has an `X-Request-Id` (the caller's own when it is 8 to 64 safe characters) that also appears in the logs.

## 12. Rate limits

| Scope | Limit |
|---|---|
| All routes | 900 per minute per API key prefix, else per IP |
| Sign in, MFA, recovery, password change or reset, invitation, confirmation, Google sign in start and callback | 10 per minute |
| Forgot password | 5 per minute |
| Registration | 5 per 10 minutes per IP |
| Chunk uploads | 6,000 per minute |
| Audit verification | 6 per minute |
| Exports | 20 per minute |
| Portal refresh | 30 per minute |
| Webhook test, portal connection test | 10 per minute |

Limits are per instance (in memory). Behind a reverse proxy or a tunnel set `TRUST_PROXY` correctly, otherwise every request looks like it comes from the proxy and shares one limit. `TRUST_PROXY` accepts `false` (default), `true`, a number of hops, or a comma separated list of proxy addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal` (for example `loopback` for cloudflared on the same computer, or `loopback, 172.29.10.2`). It is passed to Fastify as given; anything else stops the server from starting.

## 13. Self registration protections

Registration is open only when `SIGNUP_ENABLED=true` (default off).

* Every outcome answers `202` with the same fixed text, never faster than `SIGNUP_MIN_MS` (600 ms). An existing address, an unconfirmed one, a declined one, the daily ceiling and internal errors all look the same.
* Validation never touches the database, so a `400` says nothing about any address.
* A hidden honeypot field (`hp`) ends the request quietly.
* Throwaway mailbox domains (140 listed) are refused with a "use your work email" message.
* Rate limit of 5 per 10 minutes per IP, and a daily ceiling (`SIGNUP_DAILY_LIMIT`, 100) checked before the address is looked at. Administrators are alerted once a day when it is hit.
* Email confirmation is required (48 hour single use link). Emails are throttled to one an hour per address and kind, and at most 3 confirmation emails an hour (5 in total) per registration.
* Emails contain fixed text only. Nothing the registrant typed is ever repeated.
* A new company starts in `onboarding` with `manual_review` on. Uploads, team invites, API keys and webhooks stay locked until K Line approves it and a DPA is on file.
* Unconfirmed registrations are deleted after 7 days, declined ones after 30 days.

## 14. Production refusals

The API will not start in production when any of these is true (`config.ts`):

* `PUBLIC_URL` is not https.
* `DEMO_MODE` is on.
* `PORTAL_FAKE` is on.
* `SCANNER=none` without `ALLOW_NO_SCANNER=true`.
* `SMTP_URL` is missing.
* `STORAGE_DRIVER=s3` without `S3_BUCKET` and `S3_ENDPOINT`.
* Signup is on without an explicit `PRIVACY_EMAIL`, or `SIGNUP_MIN_MS` is below 600.
* `SCRYPT_LOG_N` is below 15.
* `TUNNEL_HOOKS_ONLY` is on (it is a development tunnel setting, see section 20).
* Google sign in is configured with a discovery address that is not https (`OIDC_GOOGLE_DISCOVERY_URL`).

In every environment (not only production) it also refuses `OIDC_REQUIRE_LOCAL_MFA` set to anything but `true`.

In every environment it also refuses a `DATABASE_URL` password shorter than 16 characters, malformed `MASTER_KEYS`, an `ACTIVE_KEY_ID`, `BLIND_INDEX_KEY_ID` or `HASH_KEY_ID` that is not in `MASTER_KEYS`, a Google client id without a secret (or the reverse), and Google sign in without a valid `OIDC_ALLOWED_DOMAIN`. The demo seed refuses to run in production. The demo routes answer `404` unless `DEMO_MODE` is on, and (since 6 Oct 2026) even then only for direct local use (section 20).

### Deployment controls (files in `deploy/`)

The reference deployment is one Hetzner server in Falkenstein or Nuremberg, Germany (`deploy/hetzner/README.md`). What the files set up:

* **Network.** Only ports 80 and 443 (and UDP 443) are published, by Caddy. The database and ClamAV sit on an `internal` Docker network with no route out. The app and worker also join an `edge` network for email, webhooks, the K Line portal, object storage and Google sign in. Caddy has a fixed address that the app trusts as its proxy (`TRUST_PROXY=172.29.10.2`). The guide adds a Hetzner Cloud Firewall, a host firewall, key only SSH from named addresses, fail2ban and unattended security updates.
* **Containers.** Every container runs with a read only file system, all Linux capabilities dropped (Caddy and ClamAV add back only what they need), `no-new-privileges`, non root users, and size limited logs. The app image has nothing writable.
* **TLS and headers.** Caddy obtains and renews certificates automatically, adds HSTS, nosniff, frame, referrer, cross origin and `Permissions-Policy` headers where the application did not, compresses only static assets, limits request bodies (8 MB plus a little for upload chunks, 2 MB elsewhere), and logs without query strings, request headers or `Set-Cookie`.
* **Secrets.** Four env files outside the repository (`app.env`, `owner.env`, `db.env`, `caddy.env`, mode 600). The running app never gets the database owner login: only the `migrate` (ops) container reads `owner.env`.
* **Data at rest.** PostgreSQL with `scram-sha-256` and data checksums, statement logging off. The data folder is meant to be on a LUKS encrypted volume that someone unlocks by hand after a reboot (or the files go to a private, versioned object storage bucket).
* **Malware scanning.** `deploy/clamd.conf` raises the stream and file limits to 600 MB and keeps archive scanning on.
* **Backups.** `backup.sh` dumps the database every night, encrypts it with `age` for an offline recipient key (the private key is never on the server, and the script refuses to run if it finds one), copies it to a Hetzner Storage Box with `rclone`, checks the copy, and deletes dumps older than 35 days locally and remotely. It can also sync the encrypted file store. `restore-test.sh` restores the newest dump into a throw away container without a network and checks tables, counts and the audit hash chain. The master keys are deliberately not in any backup.

## 15. Known gaps

These are known and accepted for now, or are waiting for a decision. Owners and next steps are in `docs/OPEN_DECISIONS.md`.

1. **The key rotation procedure has not been rehearsed on production sized data.** `cli rewrap` exists and is tested, but nobody has run the whole procedure (new key, restart, dry run, rewrap, verified backup, removal of the old key) on a copy of real data. Losing a master key loses the data it protects: key custody and backups of the keys are organisational tasks.
2. **Google sign in is the only single sign on**, only for K Line staff, and it trusts Google Workspace for the first factor. An authenticator code is always required afterwards (fixed in the code on 5 Oct 2026: `OIDC_REQUIRE_LOCAL_MFA=false` is refused).
3. **Free text is not encrypted.** Claim summaries, descriptions, item notes and messages, hold reasons, material names and factory event notes are stored as plain text typed by people. The interface warns people not to type patient names.
4. **The patient ID of a direct manufacturing case is stored in plain text** (`cases.partner_case_id`) while the case lives. It also appears in API results, webhooks (`case_id`) and exports. It is an identifier, not a name, but it is personal data in combination with other data. It is removed when the case is purged or erased (section 19). The partner case ID of a standard case stays after a retention purge (it is the partner's own reference) and goes with an erasure on request.
5. **Webhook delivery has not been tested over real TLS.** The tests use the development allowance for `http://localhost`.
6. **ClamAV stream limit.** clamd refuses streams above its `StreamMaxLength` (25 MB by default), and case files can be 512 MB. The production file `deploy/clamd.conf` sets `StreamMaxLength` and `MaxFileSize` to 600 MB, but nobody has tested a 512 MB file through it yet. A limit error rejects the file with `scan_failed` (it fails closed, but honest files would be refused). Keep the limits if the ClamAV image or its configuration changes.
7. **The audit chain is not anchored outside the database.** A person with owner access to the database could rewrite the whole chain and the verification would still pass. Export the latest `audit_anchor` hash to a separate system on a schedule.
8. **`audit-trim` is not scheduled** and the audit log keeps IP addresses and user agents of staff and partner users for as long as it is kept.
9. **The invitation form reveals whether an email address is taken** (`409 email_unavailable`). It needs a signed in person with `team.manage` and a fresh step up, but the address space is global.
10. **Content security policy allows inline styles** (`style-src 'unsafe-inline'`). Scripts remain strictly external. The application sets no `Permissions-Policy` header; the production Caddy file adds one (camera, microphone, geolocation, payment, USB and interest cohort denied). Without that proxy the header is missing.
11. **Rate limits are in memory per instance.** More than one API instance multiplies the limits.
12. **Erasure on request does not reach copies outside the Hub.** The K Line customer portal keeps its own copy of a direct manufacturing case (the answer and the audit entry say so), a factory system may have downloaded files, follow up cases (replacement or rework) keep their own copy of the name and case ID, and backups keep the data for up to 35 days (`gdpr/RETENTION.md`).
13. **The transfer gate relies on data kept by people.** The adequacy list in `shared/geo.ts` is a static default; the per site flag grants adequacy but cannot withdraw it for a country on the list. The United States needs SCCs or a Data Privacy Framework decision that Legal records (`gdpr/TRANSFERS.md`).
14. **No automated dependency or vulnerability scanning** is configured in the repository, and there are no browser (end to end) tests.
15. **Backups, the storage host and the operator routine** depend on people. The scripts exist (`deploy/hetzner/backup.sh`, `restore-test.sh`), but the private backup key, the master keys and the disk passphrase must be kept offline by named people, the restore test must really be run every month, and the volume must be unlocked by hand after each reboot. None of that can be checked from the code.

## 16. Reporting a vulnerability

Please report security problems privately. Do not open a public issue and do not test against real patient data.

* Write to the K Line support address (`[SUPPORT_EMAIL]`, the value of `SUPPORT_EMAIL` in production) with the subject "Security report".
* If personal data may be exposed, also copy the privacy contact (`[PRIVACY_EMAIL]`). Breach handling is described in `docs/gdpr/BREACH_RUNBOOK.md`.
* Say what you found, how to reproduce it, and what you think the impact is. Include the `X-Request-Id` of a failing request if you have one.

K Line should confirm receipt, fix confirmed problems in good time, and tell the reporter when it is fixed. The exact timings and any safe harbour wording are for K Line Legal and Compliance to decide. They are not promised here.

## 17. Penetration test recommendation

Commission an independent penetration test before real patient data goes in, and repeat it after major changes. Suggested scope:

* Tenant isolation: change ids in every route, try row level security bypass through every write path, and check the bookkeeping tables.
* Authentication: sign in, MFA, recovery, reset and invitation flows, lockout and timing, session handling, step up bypass and CSRF.
* Upload pipeline: malware and polyglot files, oversized streams, the scanner failing, SVG and PDF active content, hostile STL and PTS files (resource use), chunk replay and out of order chunks.
* Server side request forgery through webhook and portal addresses, including DNS rebinding and redirects.
* API keys: scope escalation, allow list bypass, key reuse across types.
* The factory API and the CSV import (injection, idempotency, stage ordering).
* Export and package downloads (formula injection, name disclosure).
* Deployment: TLS settings, headers behind the proxy, database and storage permissions, backups, secrets handling and the ClamAV configuration.

Retest every fixed finding, and keep the report with the records of processing.

## 18. Portal webhook receiver

`POST /api/hooks/kline-portal/:hookId` is the one public write route that accepts requests from another system. Details are in `docs/integration/PORTAL_WEBHOOK.md`. The controls:

* Authenticated by a random secret per company (`whsec_`, 32 random bytes), sent in `X-KLINE-SECRET-TOKEN`, stored field encrypted (AAD `org|<org id>|portal_hook`), shown once, rotated on request (the old secret stops at once) and covered by `cli rewrap` (kind `portal_keys`). Compared in constant time on SHA-256 digests. Wrong or missing secret: one generic 401, a counter, and at most one audit entry a minute per receiver (counts only).
* No session and no CSRF for this route (it is on the CSRF exempt list and cookies are not read). Body limit 256 KB, 120 requests a minute per IP and 600 per receiver.
* The body holds patient names and is an untrusted hint only. It is read as raw bytes and only `type` and `uuid` are looked at. It is never logged, stored, echoed or put into jobs, case events, notifications, audit entries or error messages. The request log shows no headers and no body, and the receiver address is hidden in logged URLs.
* A message can only trigger a status check of one of the same company's own open cases, found under that company's row level security context. Anything else answers 200 and does nothing, so existence of a case is not revealed. The status check reads the real status from the portal API with the company's own credentials, so a forged message cannot change a case.
* Management (create, rotate, delete) needs `integration.manage`, an approved company and step up, and is audited without the secret.

## 19. Erasure on request, scrubbing and the transfer gate

Added on 5 Oct 2026.

| Control | Implementation | Code |
|---|---|---|
| Erasure on request | `POST /api/cases/:id/erase` needs `case.erase` (partner `admin`, `kl_admin`), a fresh authenticator code (step up), a session (not an API key) and the case reference in the body (`confirmRef`). Partners reach only their own organisation's cases (another organisation's case is `404`); `kl_admin` any case. Drafts are refused (`409 use_delete_for_drafts`, delete them), a case already purged or erased answers `409 already_erased`. It runs the same code as the retention purge (`wipeCaseData`): stored chunks and file rows to `purged`, wrapped key, nonce prefix, key id and file name cleared in the same transaction, stored objects still used by a live file of a replacement or rework case kept until that file goes, names, instructions and blind indexes removed. It also removes the partner case ID of every case type. The case event `erased`, the audit entry `case.erased` (to the partner organisation, readable by the partner, with who did it) and an in app notice to the organisation's administrators carry references and counts only. K Line intake is told by reference when the case was ready or at the factory. For a direct manufacturing case the answer, the event and the audit entry say that the K Line portal keeps its own copy (`portalCopyRemains`). An erased case cannot be changed, submitted, routed or released any more (`409 case_erased`). | `routes/cases.ts`, `services/erasure.ts`, `services/retention.ts` |
| Scrubbing | One `scrubCase` service runs after every purge and erasure, and the daily job runs it for purged cases that do not have `scrubbed_at` yet. It replaces with `[removed]`: hold reasons (`cases.hold_reason` and the `reason` and `note` of case events), and the summary, description, root cause, corrective action, decision note, item notes and the messages written by people of the case's claims. It removes the patient ID in `cases.partner_case_id` (direct cases), `case_id` and `partner_case_id` from webhook delivery payloads of the case reference, and puts the reference in place of the case ID in notification text. References, dates, counts and status stay. | `services/scrub.ts` |
| Transfer gate re-checks | Besides submit and routing, the gate runs when the factory pulls cases (`GET /api/mes/v1/intake`), when it downloads a file (`GET /api/mes/v1/files/:id`, `403 transfer_blocked`) and in the daily retention job. A standard case in `ready` or `received` at a site that is no longer legal for the partner (SCC withdrawn or expired, site flags changed) goes `on_hold` with the fixed reason "Transfer to this site is no longer covered. K Line will contact you.", a case event, the audit entry `case.transfer_blocked`, a notice to K Line intake by reference and the usual partner notice. A case in production only stops downloading. An agreement counts only if it is not withdrawn, is signed and `valid_until` is empty or not past. Direct manufacturing cases have no site routing and are not subject to the gate. | `services/transferGate.ts`, `services/transferCheck.ts`, `services/mes.ts` |
| Failed email jobs | The payload (address, one time link) of an `email.send` job is wiped when it finishes, succeeded or failed for good (retries keep it until the last attempt). The retention job wipes the payload of any `email.send` job older than 24 hours whatever its state (a queued one is marked failed: an old email is never sent late). The error text holds no address or link. Migration 009 cleaned existing failed jobs. | `worker.ts`, `jobs.ts`, `services/retention.ts` |
| Personal case addresses | A user's own case address (name, phone, email, street) is personal data kept in `users.case_address`. Only that user reads or writes it, through `/api/account/case-address` (no user id is accepted); it is behind tenant row level security, never returned by another route, webhook, export or the partner API, and the audit entry `account.case_address_changed` holds field names only. It is removed with the user's organisation. | `services/userCaseAddress.ts`, `routes/account.ts`, `migrations/010_user_case_address.sql` |
## 20. Tunnels, demo data and the fixes after exploratory testing

Added on 6 Oct 2026, after an exploratory test of the development Hub that the owner publishes through cloudflared.

| Control | Implementation | Code |
|---|---|---|
| Demo data is for direct local use only | `GET /api/demo/accounts` (the shared password and live authenticator codes), `/api/demo/mailbox`, `/api/demo/registrations`, `/api/demo/sample-cases.zip` and the `demo` hints in `GET /api/auth/me` need `DEMO_MODE=true` **and** a request without any of the headers `x-forwarded-for`, `forwarded`, `cf-connecting-ip`, `cf-ray`, `x-real-ip` **and** a socket peer that is a loopback or private address (never the forwarded client address). Otherwise the routes answer `404 not_found` and `/api/auth/me` answers `demo: { enabled: false, code: null }`. A tunnel connects from 127.0.0.1, so the headers are what tell it apart. | `http/proxy.ts` (`demoAllowed`), `routes/demo.ts`, `routes/auth.ts` |
| `TUNNEL_HOOKS_ONLY` | Boolean, default false, refused when `NODE_ENV=production`. When true an early `onRequest` hook (before every other hook) answers `404 { code: 'not_found' }` to any request that carries one of those headers, unless the path is `/api/hooks/kline-portal/<id>` or `/api/health`. A public tunnel then exposes only the portal webhook receiver (which has its own secret) and the health check. Direct requests (no proxy headers) are not touched. | `app.ts`, `config.ts` |
| `TRUST_PROXY` | Passed to Fastify as `false`, `true`, a number of hops, or a comma separated list of addresses, CIDR ranges and the names `loopback`, `linklocal`, `uniquelocal`. A value that is none of these stops the server from starting. Set it to `loopback` for a tunnel on the same computer; without it every visitor looks like the tunnel and shares one rate limit (and the audit log records the tunnel's address). | `config.ts` (`parseTrustProxy`) |
| A held case cannot be pushed back into production | Submitting again from `on_hold` always puts the case at `submitted` (manual K Line review), whatever `manual_review` says, whether K Line or the factory put it on hold. The `resubmitted` event and audit entry remain. K Line routes it again. | `services/cases.ts` (`submitCase`) |
| Factory event sanity | An event dated more than 24 hours before the case was created, or more than 3 years ago, is an `error` ("The time is not plausible for this case."); the event id is not used up. A future time is treated as now. `DELIVERED` for a case that has not shipped is `ignored` ("Send SHIP before DELIVERED."), so a case can never be delivered without the carrier, tracking number and aligners shipped that `SHIP` records. | `services/stageEngine.ts` |
| Stage map | Replacing the map needs step up, and a code that appears twice (whatever its capitals) is refused with `400 duplicate_code`. | `routes/mes.ts`, `services/mes.ts` |
| Stock corrections | A correction that would take a material's stock at a site below zero is refused with `409 would_go_negative`. | `services/materials.ts` |
| Manual webhook retry | A retry clears `delivered_at`, so a delivery that is pending again no longer says it was delivered. | `services/webhookAdmin.ts` |
| File names | A name longer than 255 characters is shortened inside its name part and keeps its extension, so it is not mistaken for an unknown file type (`415`). | `services/files.ts` |
| Claims | The same aligner with the same defect twice in one claim is refused (`400 duplicate_item`). | `services/claims.ts` |
| Case IDs | No `..`, and no dot or slash at the start or the end, in addition to the old alphabet and length rules. | `shared/filenames.ts` (`caseIdRuleProblem`) |

Decisions and limits: the intake audit entry now belongs to K Line's log, so a partner's access log no longer shows each factory poll, only each file the factory system downloads (`file.download`). The demo hints stay available to someone who browses to the Hub directly on the same computer or network: they are for development, and production refuses to start with demo mode on.
