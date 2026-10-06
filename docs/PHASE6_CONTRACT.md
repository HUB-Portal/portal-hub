# Phase 6 contract: partner API, API keys, webhooks, exports, notifications and email

Status: **server implemented and tested** (`server/src/routes/{apiKeys,webhooks,exports,account,v1}.ts`, `services/{apiKeysAdmin,webhookAdmin,webhookDelivery,webhooks,netSafety,exports,v1,notify}.ts`, migration `006_integrations.sql`, tests `phase6.unit.test.ts`, `phase6.test.ts`, `phase6.webhooks.test.ts`). **This file matches the code.** Source: original brief sections 7 (API keys, rate limits), 17 (Integrations), 18 (Notifications and email). Phases 1 to 5 are done (BRIEF.md and PHASE2 to PHASE5 contracts). The two integration guides for outside developers are `docs/integration/PARTNER_API.md` and `docs/integration/MES_INTEGRATION.md`.

Conventions are those of PHASE2 to 5: JSON under `/api`, session cookie plus `x-csrf-token` on writes, errors `{code, message, ...extra}`, `400 invalid_request` carries `fields: [{path, message}]`, camelCase for everything the web app sees (the partner API under `/api/v1` is snake_case). Send `{}` as the body of POST requests without data. "Step up" means an authenticator code within the last 10 minutes, else `403 step_up_required`. No patient data in payloads, logs, emails or job payloads; interface text is plain British English without dash separators.

## 0. Data model (migration 006, additive)

Migration 001 had `api_keys` but **no webhook tables** (the first draft said it did). Migration 006 adds:

* `api_keys.revoked_by`.
* `webhooks` (`id, org_id, url, events[], description, secret_enc, active, disabled_reason, disabled_at, consecutive_failures, last_attempt_at, last_success_at, last_status_code, last_outcome, secret_rotated_at, created_by, created_at, updated_at`). `secret_enc` is a field encrypted value with AAD `webhook|<id>`.
* `webhook_deliveries` (the outbox: `id` (also the payload `id` and `x-kph-delivery`), `org_id, webhook_id, event, payload jsonb, status pending|retrying|delivered|dead, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error, locked_until, delivered_at, created_at`).
* `email_notice_log` (`user_id, dedupe_key, org_id, sent_at, pending jsonb`): the 15 minute window of email notices.
* All three with `tenant_isolation` row level security on `org_id` (partners see only their own rows).

## 1. API keys (partner side)

All routes: partner people only, session only (API keys and K Line staff get `403`, even K Line administrators who hold `integration.manage`). Permission `integration.manage` (partner `admin`). Reading is open to a company that is not approved yet; creating needs an approved company (`403 org_not_approved`).

* `GET /api/api-keys` returns
  ```
  { scopes: ["cases:read","cases:write","patients:read","claims:read","materials:read"],
    limits: {maxActive: 20, maxCidrs: 20, maxExpiryDays: 730, defaultExpiryDays: 365},
    items: [{id, name, prefix, scopes, cidrs, expiresAt, lastUsedAt, lastUsedIp, createdAt, createdByName, revokedAt, status: "active"|"expired"|"revoked"}] }
  ```
  newest first. The secret and its hash are never returned.
* `POST /api/api-keys` **[step up]** `{name (1 to 80), scopes: string[] (at least one of the five), cidrs?: string[] (IPv4 or IPv6 addresses or CIDR ranges, at most 20), expiresInDays?: 1..730 (default 365)}` returns **201 `{id, key, prefix, expiresAt}`**. `key` (`kph_<12 hex>_<43 base64url>`) is shown once. Errors: `400 scope_dependency` (`patients:read` needs `cases:read`), `400 invalid_cidr`, `400 invalid_request` (name, unknown or service scope, expiry), `409 too_many_keys` (20 active keys; revoked and expired ones do not count).
* `DELETE /api/api-keys/:id` **[step up]** returns `{ok: true}`. `404` for another company's key, `409 already_revoked`. The key stops working at once.
* Last use (`lastUsedAt`, `lastUsedIp`) is written by the authentication itself at most once a minute per key (the condition is part of the UPDATE, so parallel requests cannot cause a write storm). The address is stored without an IPv4 mapped prefix.
* Audit (partner log, actor the person): `api_key.created {prefix, name, scopes, cidrs (count), expiresAt}`, `api_key.revoked {prefix, scopes}`. Never the key or its hash.
* K Line service keys are unchanged (phase 3, `/api/service-keys`).

## 2. Partner ERP API `/api/v1`

Bearer API key only: `Authorization: Bearer kph_...`. For the whole `/api/v1` prefix (`app.ts`): the session cookie is **never read** (no key gives `401 api_key_required`, also with a perfectly good cookie); no CSRF; a bad, revoked, expired or out of range key gives `401 invalid_api_key` (same answer for all); a K Line service key gives `403 wrong_key_type`; a missing scope gives `403 insufficient_scope`. Keys never reach `/api/mes`, the console routes or any people only route (`403`), service keys never reach `/api/v1` or any partner route. Every `/api` response carries `X-Request-Id` (the caller's own `x-request-id` when it is 8 to 64 characters of `A-Za-z0-9._:-`, else a UUID). Rate limit: 900 a minute per key prefix, with the plugin's `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` headers and `429 {code: "rate_limited"}`.

Lists answer `{items, total, page, page_size}` (`page` from 1, `page_size` 1 to 100, default 25; `400 invalid_request` beyond). Dates `YYYY-MM-DD` (date filters use the Europe/Berlin calendar day), timestamps ISO 8601 UTC. Write responses are the plain case object (no `{case}` wrapper).

Case object (`v1Case`):
```
{ ref, case_id, status, simple_status: draft|submitted|production|shipped|cancelled, stage, stage_label, kind, mode: standard|direct, priority, brand (name), site (code),
  due_date, expected_ship_date (same value), hold_reason, aligners: {upper, lower, templates, shipped}, carrier, tracking_number,
  created_at, submitted_at, ready_at, received_at, shipped_at, delivered_at, cancelled_at, updated_at,
  checks: {errors: [{code, message, file_id?, arch?, step?}], warnings: [...]}, warnings_acknowledged,
  portal?: {status, case_uuid?}   // direct cases only
  parent_ref, patient?: {first_name, last_name, name} }   // patient ONLY with patients:read
```
Without `patients:read` there is **no `patient` key at all** and no name anywhere. Standard cases store one name: `first_name` and `last_name` are then `null` and `name` holds it. Create and submit responses never carry `patient`.

* `GET /api/v1/cases?status=&simple_status=&mode=&from=&to=&updated_since=&case_id=&page=&page_size=` [cases:read]. `status` any of the nine statuses, `simple_status` one of the five, `from`/`to` creation day (Berlin), `updated_since` ISO 8601 timestamp with offset (oldest change first when given, else newest case first), `case_id` the partner's own ID (exact, case insensitive; not in the first draft). With `patients:read` one audit entry per page: `case.names_revealed {via: "api_v1_list", count, refs}` (actor `api_key`).
* `GET /api/v1/cases/:key` [cases:read], `:key` = reference (any case) or the partner's own case ID (URL encoded; the newest, preferring one that is not cancelled). Returns the case object plus
  `files: [{id, name, kind, arch, step, template, size, state, sha256}]` (name is canonical: `upper/U01.stl`, `lower/L12_T.pts`, `other/document.pdf`; never the partner's own file name) and
  `events: [{type, at, stage, message, source}]` (`message` is fixed wording per event type, `source` is `Partner`, `K Line`, `Factory system`, `K Line portal` or `System`; no hold reasons, notes or other typed text). With `patients:read` one audit entry `case.name_revealed {ref, via: "api_v1"}`.
* `POST /api/v1/cases` [cases:write] `{case_id?, patient_name?, instructions? (max 8000), priority?: normal|rush, brand? (name of a brand of the company)}` returns **201** the case object. At least `case_id` or `patient_name` (`400 identifier_required`); `400 invalid_case_id`, `400 invalid_brand`, `409 case_id_exists`, `403 org_not_approved`. Standard draft cases only (direct manufacturing cases come through the bulk flow).
* `POST /api/v1/cases/:key/files` [cases:write] `{name, size, arch?: "upper"|"lower"|null, step?: 0..999|null, template?}` returns 200 `{file_id, chunk_size, chunk_count, received: number[], state}` (resumes when the same name and size were registered before). Then the existing routes, which accept keys with `cases:write`: `PUT /api/uploads/:file_id/chunks/:idx` (`content-type: application/octet-stream`, header `x-chunk-sha256`), `POST /api/uploads/:file_id/complete` with `{}`. Uploads are audited with actor `api_key`.
* `GET /api/v1/files/:id` [cases:read] returns `{id, name (canonical), kind, arch, step, template, size, state: uploading|processing|ready|rejected, sha256, case_ref, errors: [{code, message}], warnings: [...], created_at}`. Case files of the key's company only, `404` otherwise.
* `POST /api/v1/cases/:key/submit` [cases:write] `{acknowledge_warnings?: boolean}` returns 200 the case object. Errors as in the portal: `409 checks_failed {errors: [...]}`, `409 warnings_need_confirmation {warnings: [...]}` (issue objects in snake_case), `409 case_not_open`, `403 org_not_approved`, `403 transfer_blocked`, `409 no_site_configured`.
* `GET /api/v1/shipments?from=&to=` [cases:read] both required, `from` not after `to` (`400 invalid_period`), at most 366 days apart (`400 period_too_long`), at most 20,000 rows (`413 too_many_rows`). Cases with status shipped or delivered whose `shipped_at` falls on a Berlin calendar day in the period, oldest shipment first:
  `{items: [{ref, case_id, shipped_at, carrier, tracking_number, aligners_shipped, aligners_upper, aligners_lower, templates, mode, kind, site}], total, total_aligners}`. Standard cases carry the count the factory reported. **The K Line portal reports no count for direct manufacturing cases, so `aligners_shipped` is upper plus lower for them** (used whenever the stored count is 0).
* `GET /api/v1/claims?status=&from=&to=&page=&page_size=` [claims:read] `status` = any claim status or `active`. Items `{number, case_ref, status, resolution, created_at, item_count}`; no summary, description, messages, evidence or patient data.
* `GET /api/v1/materials` [materials:read] `{items: [{sku, name, category, unit, per_case, per_aligner, min_stock, active, stock: [{site, on_hand, in_transit, used_28d, days_of_cover, low_stock}]}]}` (the same numbers as `GET /api/materials`).

## 3. Webhooks (partner side)

Routes: partner people only, session only, permission `integration.manage` (K Line staff and keys get `403`). Changes (create, update, delete, rotate) need step up; every route that changes something or calls the endpoint (`POST`, `PATCH`, `DELETE`, retry, test) also needs an approved company (`403 org_not_approved`); the two list routes and the delivery detail stay readable.

Events (`WEBHOOK_EVENTS`): `case.submitted case.on_hold case.received case.stage_changed case.shipped case.delivered case.cancelled claim.updated materials.low_stock spec.updated`. `webhook.test` is sent by the test button and is not subscribable.

Payload (the exact body that is signed): `{id, type, created_at, org_code, data}`; `id` is the delivery id and stays the same across retries and manual resends.
* case events: `data = {ref, case_id, status, simple_status, stage, stage_label, site}` plus `carrier`, `tracking_number`, `aligners_shipped` when the case has shipped (status shipped or delivered and the value is set). `case_id` is the partner's own case ID (for direct manufacturing cases this is the patient ID; there is no name and no text anywhere).
* `claim.updated`: `{claim_number, case_ref, status, resolution?}`. `spec.updated`: `{version, status}`. `materials.low_stock`: `{sku, site, on_hand, min_stock}`.
* No hold reasons, notes, instructions, claim text, file names, material names or patient names. Payloads larger than 64 KB are not queued.

Routes (all camelCase):
* `GET /api/webhooks` returns `{items: Webhook[], events: [...10 event names], limits: {maxWebhooks: 10}, retryMinutes: [1,5,30,120,360,720,1440], maxAttempts: 8}`.
  `Webhook = {id, url, events, description, active, status: "active"|"disabled", disabledReason: null|"too_many_failures"|"switched_off", disabledAt, consecutiveFailures, lastAttemptAt, lastSuccessAt, lastStatusCode, lastOutcome: "delivered"|"failed"|null, openDeliveries (pending or retrying), secretRotatedAt, createdByName, createdAt, updatedAt}`. The secret is never returned.
* `POST /api/webhooks` **[step up]** `{url (max 500), events: string[] (1 to 20, known events, duplicates removed), description? (max 200)}` returns **201 `{id, secret, webhook}`**; `secret` is `whsec_<43 base64url>`, shown once. Errors: `400 invalid_webhook_url` with `reason` (`invalid_url`, `not_https`, `has_credentials`, `blocked_host`, `blocked_address`, `unresolvable`), `400 invalid_event` (with `allowed`), `409 too_many_webhooks` (10 per company).
* `PATCH /api/webhooks/:id` **[step up]** `{url?, events?, active?, description? (or null)}` returns `{webhook}`. `active: false` switches off (`disabledReason: "switched_off"`); `active: true` switches on, re-checks the address, sets `consecutiveFailures` to 0 and clears the reason.
* `POST /api/webhooks/:id/rotate-secret` **[step up]** returns `{id, secret}` (shown once; the old secret stops working at once). `DELETE /api/webhooks/:id` **[step up]** returns `{ok: true}` (its deliveries go with it).
* `GET /api/webhooks/:id/deliveries?status=&event=&page=&pageSize=` (`status` = pending, retrying, delivered, dead; `pageSize` up to 100, default 25) returns `{items: [{id, event, status, attempts, maxAttempts: 8, lastStatusCode, lastError, nextAttemptAt, lastAttemptAt, createdAt, deliveredAt}], total, page, pageSize}`, newest first. `lastError` is fixed wording, never the endpoint's own answer.
* `GET /api/webhooks/:id/deliveries/:deliveryId` returns `{delivery, payload}` (`payload` is the JSON that was sent).
* `POST /api/webhooks/:id/deliveries/:deliveryId/retry` returns `{delivery}`: starts a new round of attempts now with the same id (`409 webhook_disabled` while the webhook is switched off, `409 delivery_in_progress` while it is being sent).
* `POST /api/webhooks/:id/test` sends a `webhook.test` event at once and returns `{ok, status, durationMs, error?}` (`status` null when nothing answered; `error` is fixed wording). Nothing is stored except the audit entry `webhook.tested`; it never counts against the failure limit; it also works on a switched off webhook. 10 per minute per webhook (`429 rate_limited`).
* Audit (partner log): `webhook.created`, `webhook.updated {changed: [...], host}`, `webhook.enabled`, `webhook.disabled`, `webhook.secret_rotated`, `webhook.deleted`, `webhook.tested`, `webhook.delivery_retried`, `webhook.auto_disabled` (actor system). Only the host of the address is logged (it may carry a token), never a secret.

Delivery:
* The outbox: `emitCaseWebhook`, `emitClaimWebhook`, `emitSpecWebhook`, `emitMaterialsWebhook` (`services/webhooks.ts`) write one `webhook_deliveries` row and one `webhook.deliver` job per active, subscribed endpoint of the organisation **inside the caller's transaction** (a rolled back change leaves nothing). `setHookObserver` still sees every internal hook first, including `case.ready`, `case.rerouted`, `case.released`, which are not subscribable.
* Internal hook to event: `case.stage_changed` with stage `received` (the factory acknowledgement or a RECEIVED/CAD code) becomes `case.received`; other stages are `case.stage_changed`. Call sites: partner submit and replacement or rework orders (`case.submitted`), partner cancel and staff or factory cancel (`case.cancelled`), holds (`case.on_hold`), the stage engine (`case.received`, `case.stage_changed`, `case.shipped`, `case.delivered`), the portal status sync for direct cases (`case.stage_changed` to Production, `case.shipped`), claims (`claim.updated`), specification proposal, signature, activation and rejection (`spec.updated`), low stock (`materials.low_stock`).
* HTTP: `POST` with `content-type: application/json`, `user-agent: KPH-Webhooks/1`, `x-kph-event`, `x-kph-delivery`, `x-kph-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` (key = the whole secret string including `whsec_`; `t` is the time of the attempt). 10 second limit, redirects are not followed (a 3xx is a failure), the answer body is read only to free the connection and never stored. 2xx is delivered. Verification snippets (Node, Python) are in PARTNER_API.md.
* Retries after 1, 5, 30, 120, 360, 720 and 1440 minutes; 8 attempts at most, then `dead`. Each retry is a `webhook.deliver` job scheduled for its time; a worker sweep every minute re-queues due deliveries whose job got lost. After 25 failed attempts in a row the webhook is switched off (`disabledReason: "too_many_failures"`), the administrators (people with `integration.manage`) get an in app notice (`webhook_disabled`) and the fixed email; a success resets the counter. Deliveries of a switched off webhook that come due end as `dead`. Deliveries older than 90 days are deleted by the retention job (report field `webhookDeliveries`).
* **SSRF protection** (`services/netSafety.ts`): at save time the address must be https, no credentials or `#`, at most 500 characters, not an internal name (`localhost`, `.local`, `.internal`, `.intranet`, `.lan`, `.home`, `.corp`, single label names) and, when an IP literal (also decimal, hex, octal forms, which the URL parser normalises), public; the name is then resolved and refused when any answer is private. At delivery the same shape check runs again and the connection itself is guarded: a custom `lookup` in the undici agent resolves the name at connect time, refuses the whole answer when any address is loopback, private, link local (including 169.254.169.254), CGNAT, multicast, reserved, documentation, NAT64, 6to4, Teredo or an IPv4 address embedded in IPv6, and Node connects to the address that lookup returned (so a name that changed its answer after saving, DNS rebinding, is refused). IP literals are judged again in the connector. The development allowance (`http` to `localhost`, `127.0.0.1`, `[::1]` only) applies when `NODE_ENV` is not `production`; production never allows it.

## 4. Exports

`GET /api/exports/cases.csv` and `GET /api/exports/shipments.csv` [export.run; people only, no keys]. Query: `from`, `to` (required, `YYYY-MM-DD`, Berlin days, `from` not after `to`), `include_names=0|1` (default 0), `date_field=created|shipped` (cases only; default `created`; shipments always use the shipping day), `orgId` (K Line only). Partners always get their own company (`orgId` is ignored). K Line finance, intake and administrators may pass `orgId` of a partner (`404` for anything else); without it they get every partner's rows, but `include_names=1` then needs `orgId` (`400 org_required`).

* Response: `text/csv; charset=utf-8`, UTF-8 byte order mark, CRLF, `content-disposition: attachment; filename="cases_<from>_to_<to>.csv"` (or `shipments_...`), streamed in batches of 500 by keyset on (date, id), at most 100,000 rows (`413 too_many_rows` with advice to choose a shorter period, nothing written).
* `cases.csv` columns: `ref, case_id, mode, kind, status, simple_status, stage, priority, brand, site, created_at, submitted_at, shipped_at, delivered_at, aligners_upper, aligners_lower, templates, aligners_shipped, carrier, tracking_number`. `shipments.csv`: `ref, case_id, mode, kind, site, shipped_at, delivered_at, carrier, tracking_number, aligners_shipped, aligners_upper, aligners_lower, templates` (shipped and delivered cases only; direct cases count upper plus lower when no count is stored). With `include_names=1` the columns `first_name, last_name, name` are added (standard cases: `name` only).
* Names need the permission `case.reveal_name` (`403 forbidden`; partner `finance` and K Line finance do not have it) **and a fresh step up** (`403 step_up_required`), in that order.
* Cells are defused against formula injection: a leading `= + - @` (except plain numbers), tab or carriage return gets a leading apostrophe.
* Audit, in the log of every company whose rows are exported (K Line exports show as "K Line staff"): `export.cases_csv` / `export.shipments_csv {from, to, dateField, rows, includeNames}` and, with names, `case.names_revealed {via: "export", export: "cases.csv"|"shipments.csv", count, from, to}` (no names). Written before the stream starts.

## 5. Notifications and email

* `GET /api/account/notifications` and `PUT /api/account/notifications {email: boolean}` (any signed in person, sessions only) return `{email: boolean}` (`users.notify_email`, default true). Audit `account.notifications_updated`. Registration, invitation and password emails are not affected.
* `notifyOrg` (`services/notify.ts`) now also queues a fixed text `notice` email to each person it is meant for who is active, has `notify_email` on and holds the permission shown: `case_stage` (only the first step into production: stage `received`, or a portal sync), `case_shipped`, `case_delivered`, `case_on_hold` ("See the reason in the platform."), `case_cancelled` [case.read]; `claim_opened`, `claim_status`, `claim_message`, `claim_decision`, `claim_closed` [claim.write]; `spec_proposed`, `spec_signed` [spec.sign]; `material_low_stock` [material.manage] (fixed text, names the K Line site code, no material name); `webhook_disabled` [integration.manage]. Every email holds one sentence, a link built from `PUBLIC_URL` (`/portal/cases/:id`, `/portal/claims/:id`, `/portal/spec/:id`, `/portal/materials`, `/portal/integrations`; for K Line staff `/console/cases/:id`, `/console/claims/:id`, `/console/specs/:orgId/:specId`) and a link to the account page. Never patient names, file names, reasons, claim text or material names.
* **Dedupe and combine**: at most one email per person and subject every 15 minutes (subject = `case:<id>`, `claim:<id>`, `spec:<id>`, `material:<id>:<site>`, `webhook:<id>`). The first notice is sent at once; later notices inside the window replace a held back copy; one `notice.flush` job per person and window sends the newest held back notice when the window ends (no email if the person switched emails off meanwhile). The bell is never affected.
* The phase 4 low stock email (which named the material) is replaced by the fixed text version above.

## 6. Docs

`docs/integration/PARTNER_API.md` (auth, scopes, pagination, errors, every endpoint with examples, the chunked upload walk through with curl and Node, webhook events, signature verification in Node and Python, retry schedule, IP allow list, rate limits, status mapping, changelog) and `docs/integration/MES_INTEGRATION.md` (service keys, intake, file download with sha256, ack, events and idempotency, stage map, CSV import, examples), both written from the code.

## 7. Route table

| Method and path | Permission | Step up | Notes |
|---|---|---|---|
| GET /api/api-keys | integration.manage | no | partner people only |
| POST /api/api-keys | integration.manage | yes | approved company |
| DELETE /api/api-keys/:id | integration.manage | yes | |
| GET /api/webhooks | integration.manage | no | |
| POST /api/webhooks | integration.manage | yes | approved company |
| PATCH /api/webhooks/:id | integration.manage | yes | approved company |
| POST /api/webhooks/:id/rotate-secret | integration.manage | yes | approved company |
| DELETE /api/webhooks/:id | integration.manage | yes | approved company |
| GET /api/webhooks/:id/deliveries | integration.manage | no | |
| GET /api/webhooks/:id/deliveries/:deliveryId | integration.manage | no | |
| POST /api/webhooks/:id/deliveries/:deliveryId/retry | integration.manage | no | approved company |
| POST /api/webhooks/:id/test | integration.manage | no | approved company, 10 per minute per webhook |
| GET /api/exports/cases.csv, /shipments.csv | export.run | only with include_names=1 (plus case.reveal_name) | people only, 20 a minute |
| GET, PUT /api/account/notifications | any signed in person | no | |
| GET /api/v1/cases, /cases/:key, /files/:id, /shipments | key scope cases:read | n/a | key only |
| POST /api/v1/cases, /cases/:key/files, /cases/:key/submit | key scope cases:write | n/a | key only |
| GET /api/v1/claims | key scope claims:read | n/a | |
| GET /api/v1/materials | key scope materials:read | n/a | |
| PUT /api/uploads/:id/chunks/:idx, POST /api/uploads/:id/complete | key scope cases:write (existing routes) | n/a | |

## 8. Deviations from the first draft of this contract

1. Migration 001 had no webhook tables; 006 creates `webhooks` and `webhook_deliveries` (and `email_notice_log`).
2. `GET /api/api-keys` answers `{scopes, limits, items}` (like `/api/service-keys`), not a bare list. Key and webhook reads are allowed for a company that is not approved yet; changes are not.
3. `/api/v1` write responses and the case detail are flat case objects (detail adds `files` and `events`), lists use `page_size` (snake case). Additions: `case_id` filter, `updated_at` field, `wrong_key_type` and `insufficient_scope` codes, `X-Request-Id` on every `/api` answer, `403` for every non partner key.
4. Bulk name reveals by key are one audit entry per page (`case.names_revealed` with count and references), not one per case; single case detail writes `case.name_revealed` as before.
5. Webhook delivery statuses are `pending`, `retrying`, `delivered`, `dead`. Delivery detail returns `{delivery, payload}`. The test call returns `{ok, status, durationMs, error?}` and stores no delivery.
6. `case.received` is its own event (the factory acknowledgement), so `case.stage_changed` covers the later stages only; `case.ready`, `case.rerouted`, `case.released` stay internal.
7. The IP actually connected to: the platform does not reliably report the peer address of a connected socket (Windows, undici), so the guard is the connect time `lookup` (the address it returns is the one Node connects to) plus a peer check wherever the address is available.
8. Exports add a `name` column next to `first_name` and `last_name`; K Line staff can export all partners without names; `shipments.csv` supports `include_names` like `cases.csv`.
9. Email notices are combined, not dropped: the newest held back notice is sent when the 15 minute window ends. `case_cancelled` is included next to the listed kinds. The phase 4 low stock email is now the generic fixed text.
10. Request logs now also hide `/api/v1/cases/<key>` path segments that are not case references or UUIDs, and the query values of `search` and `case_id` (they can hold patient names or IDs).
11. The `Europe/Berlin` calendar day is used for `from`/`to` on cases, claims, shipments and exports.

## 9. Web app

Partner pages (permission `integration.manage` unless noted) under "ERP and API" (`/portal/integrations`): tabs **API keys** (table, create dialog with scope checkboxes that explain each scope and warn that patients:read exposes names, CIDR list, expiry; show the new key once with copy button and a clear "you cannot see it again" notice; revoke with step up), **Webhooks** (list with status, last delivery, failures; create/edit dialog with event checkboxes; secret shown once; rotate; test button with result; delivery history drawer with filters and payload viewer and Retry; re-enable after auto disable), **Exports** (period picker, date field, include names checkbox explaining the step up and audit, buttons for cases.csv and shipments.csv; `export.run`), **Developer notes** (short inline guide with the base URL, example curl, links to the docs text rendered in the page; signature verification snippet with copy buttons). Account page: "Email notifications" switch (`/api/account/notifications`). Locked notice when the company is not approved (`403 org_not_approved` on changes). K Line console: nothing new required except the audit log showing key and webhook actions.
