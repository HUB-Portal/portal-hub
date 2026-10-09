# Portal Hub: partner API

This guide is for the developers of a partner company (an aligner brand, lab or clinic) who connect their own system (ERP, practice software, order system) to the Portal Hub. It describes what the Hub does today.

Contents: [Quick start](#quick-start) · [Authentication and keys](#authentication-and-keys) · [Conventions](#conventions) · [Status mapping](#status-mapping) · [Endpoints](#endpoints) · [Uploading files](#uploading-files-step-by-step) · [Webhooks](#webhooks) · [Exports](#csv-exports) · [Limits](#limits-and-good-behaviour) · [Changelog](#changelog)

Base URL: the address of your Hub, for example `https://hub.example.com`. Every path below starts with `/api/v1`, except the three upload calls that start with `/api/uploads`.

## Quick start

1. Get a key with the scopes the integration needs. Creating keys needs the permission `integration.manage`, which no partner role has at the moment, so ask your K Line contact. The key is shown once. Copy it into your secret store.
2. Call the API with the key:
   ```bash
   curl -s https://hub.example.com/api/v1/cases?page_size=5 \
     -H "Authorization: Bearer kph_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
   ```
3. Create a case, upload its files, submit it (see [Uploading files](#uploading-files-step-by-step)), then follow its progress by polling `GET /api/v1/cases` or by receiving [webhooks](#webhooks).

## Authentication and keys

Send the key in the `Authorization` header on every request: `Authorization: Bearer kph_<12 hex>_<43 characters>`. Nothing else authenticates on `/api/v1`. A browser session cookie is ignored and the call is refused with `401 api_key_required`, so the API needs no CSRF token.

* A key belongs to one company and can only ever see that company's data. Another company's cases answer `404`.
* The key is shown once when it is created. The Hub stores only a keyed hash, so a lost key cannot be recovered: create a new one and revoke the old one.
* **Expiry**: 1 to 730 days, 365 by default. An expired key answers `401 invalid_api_key`. Create the replacement before it expires and switch over.
* **IP allow list** (optional): up to 20 addresses or CIDR ranges, IPv4 or IPv6 (`203.0.113.7`, `203.0.113.0/24`, `2001:db8::/32`). A request from any other address is refused with the same `401 invalid_api_key` as a wrong key. Behind a proxy, make sure the Hub sees the real client address.
* A key can be revoked at any time (needs `integration.manage`, with an authenticator code). It stops working at once. You can have 20 active keys per company. Key creation and revocation are in your company's access log; the list shows when and from which address each key was last used (updated at most once a minute).
* Keys are for your systems only. They never work on K Line's internal interfaces, and K Line's own service keys never work here.

### Scopes

| Scope | Allows |
|---|---|
| `cases:read` | List and read cases, case files, events, and the shipments list. |
| `cases:write` | Create cases, register and upload files, submit. Needs `cases:read` in practice to follow up, but is checked on its own. |
| `patients:read` | Adds the `patient` object (first name, last name) to case results. **Exposes patient names**: give it to as few systems as possible. Needs `cases:read` on the same key. Every read is written to your company's access log. |
| `claims:read` | List quality claims (numbers, status, dates; no free text). |
| `materials:read` | Read the materials you supply and the stock per K Line site. |

A call without the needed scope answers `403 insufficient_scope`.

## Conventions

* **JSON** in and out, UTF-8, `snake_case` names. Send `Content-Type: application/json`. If you send a JSON body, send a real one (`{}` when there is nothing to say); an empty body with a JSON content type is refused.
* **Dates** are `YYYY-MM-DD`. Filters that take dates use the calendar day in **Europe/Berlin**. **Timestamps** are ISO 8601 in UTC (`2026-09-24T13:05:41.120Z`).
* **Pagination**: lists take `page` (from 1) and `page_size` (1 to 100, default 25) and answer `{"items": [...], "total": 137, "page": 1, "page_size": 25}`.
* **Request ids**: every answer has an `X-Request-Id` header. You may send your own `X-Request-Id` (8 to 64 characters of `A-Za-z0-9._:-`) and it is echoed back. Quote it when you contact support.
* **Errors** have the status code and a body `{"code": "...", "message": "..."}` (plain English, meant for people). Validation errors add `"fields": [{"path": "page_size", "message": "..."}]`. Code on `code`, not on `message`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Something in the request is missing or not valid (see `fields`). |
| 400 | `identifier_required`, `invalid_case_id`, `invalid_brand`, `invalid_period`, `period_too_long` | The named problem. |
| 401 | `api_key_required` | No `Authorization: Bearer` header. |
| 401 | `invalid_api_key` | Wrong, revoked or expired key, or a request from an address outside the key's allow list. One answer for all of them. |
| 403 | `insufficient_scope` | The key lacks the scope this endpoint needs. |
| 403 | `wrong_key_type` | A K Line service key was used here. |
| 403 | `org_not_approved` | K Line has not approved your company yet (no uploads, no submitting). |
| 403 | `transfer_blocked` | The case cannot legally be produced at any available site. Contact K Line. |
| 404 | `not_found` | Unknown, or belongs to another company. |
| 409 | `case_id_exists` | You already have a case with that case ID. |
| 409 | `case_not_open` | The case is not a draft or on hold, so files cannot be added and it cannot be submitted. |
| 409 | `checks_failed` | Errors in the case's checks. `errors` lists them. |
| 409 | `warnings_need_confirmation` | Warnings. `warnings` lists them; submit again with `acknowledge_warnings: true`. |
| 409 | `no_site_configured` | Your company has no production site yet. |
| 409 | `case_address_required` | A direct manufacturing case needs a case address, and there is none that is complete. Keys have no person, so cases created and submitted with a key are always sent with your **company's** case address (the company profile), never with a user's own address. Add it in the company profile first. |
| 409 | `upload_incomplete` | Not all chunks have arrived (`missing` lists the numbers). |
| 413 | `too_many_rows`, `file_too_large` | Ask for a shorter period; files are at most 512 MB. |
| 415 | `file_type_not_allowed` | The file type is not accepted. |
| 422 | `checksum_mismatch`, `invalid_chunk_size` | A chunk was damaged or has the wrong size. Send it again. |
| 429 | `rate_limited` | Slow down (see [Limits](#limits-and-good-behaviour)). |

## Status mapping

Hub statuses are precise; partners also see a simple four step status. Both are in every case object (`status` and `simple_status`).

| `simple_status` | `status` values | Meaning |
|---|---|---|
| `draft` | `draft` | You are still adding files. |
| `submitted` | `submitted`, `on_hold`, `ready` | Sent to K Line. `submitted` waits for K Line's review, `on_hold` needs your attention (`hold_reason`), `ready` is approved for production at `site` and waits for the factory. |
| `production` | `received`, `in_production` | The factory has the case. `stage` and `stage_label` (for example `printing`, "3D printing") say where. |
| `shipped` | `shipped`, `delivered` | On its way (`carrier`, `tracking_number`, `aligners.shipped`) or delivered. |
| `cancelled` | `cancelled` | Cancelled. |

Factory stages in order: `received`, `printing`, `thermoforming`, `trimming`, `finishing`, `quality_check`, `packing`, `shipped`, `delivered`. Direct manufacturing cases (`mode: "direct"`) are produced through the K Line portal, so they have no `stage`; they move from `submitted` to `in_production` to `shipped`.

## Endpoints

### List cases

`GET /api/v1/cases` (scope `cases:read`)

| Query | Meaning |
|---|---|
| `status` | One of `draft`, `submitted`, `on_hold`, `ready`, `received`, `in_production`, `shipped`, `delivered`, `cancelled`. |
| `simple_status` | One of `draft`, `submitted`, `production`, `shipped`, `cancelled`. |
| `mode` | `standard` or `direct`. |
| `from`, `to` | Creation day, `YYYY-MM-DD`, both inclusive. |
| `updated_since` | ISO 8601 timestamp with offset. Only cases changed at or after it, **oldest change first**, which suits a sync job: remember the last `updated_at` you processed. |
| `case_id` | Your own case ID (exact match, not case sensitive). |
| `page`, `page_size` | Pagination. Without `updated_since`, newest cases come first. |

```bash
curl -s "https://hub.example.com/api/v1/cases?simple_status=production&page_size=2" -H "Authorization: Bearer $KEY"
```
```json
{
  "items": [
    {
      "ref": "ACME-000412",
      "case_id": "55813",
      "status": "in_production",
      "simple_status": "production",
      "stage": "thermoforming",
      "stage_label": "Thermoforming",
      "kind": "new",
      "mode": "standard",
      "priority": "normal",
      "brand": "Smile Line",
      "site": "PT-CHV",
      "due_date": "2026-09-28",
      "expected_ship_date": "2026-09-28",
      "hold_reason": null,
      "aligners": { "upper": 12, "lower": 12, "templates": 2, "shipped": 0 },
      "carrier": null,
      "tracking_number": null,
      "created_at": "2026-09-21T08:14:02.311Z",
      "submitted_at": "2026-09-21T08:40:55.010Z",
      "ready_at": "2026-09-21T09:02:17.004Z",
      "received_at": "2026-09-22T06:30:00.000Z",
      "shipped_at": null,
      "delivered_at": null,
      "cancelled_at": null,
      "updated_at": "2026-09-24T11:45:09.672Z",
      "checks": { "errors": [], "warnings": [{ "code": "missing_pts", "message": "The upper aligner for step 3 has no trim line (PTS).", "file_id": "0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11", "arch": "upper", "step": 3 }] },
      "warnings_acknowledged": true,
      "parent_ref": null
    }
  ],
  "total": 37,
  "page": 1,
  "page_size": 2
}
```

Fields: `ref` is the Hub's reference (`<company code>-<number>`); `case_id` is your own ID; `kind` is `new`, `replacement` or `rework`; `parent_ref` points to the original case of a replacement or rework; `priority` is `normal` or `rush`; `brand` is the brand name or null; `site` is the K Line production site code or null; `due_date` and `expected_ship_date` are the same planned shipping day; `aligners` counts distinct aligner steps per arch (templates separate) and the number shipped; `checks` are the results of the automatic file checks (`file_id`, `arch` and `step` appear when an issue belongs to one file). Direct manufacturing cases add `"portal": {"status": "pushed", "case_uuid": "..."}` (status `pending`, `pushing`, `pushed` or `failed`).

**Patient names.** Without the `patients:read` scope the result has **no `patient` key at all**, and the session style routes (`GET /api/cases`, `GET /api/cases/:id` and their create, change and submit answers) carry no `patientMasked`, `hasPatientName` or name field either. A key without the scope also cannot find a case by a patient name. With it, every case has `"patient": {"first_name": "...", "last_name": "...", "name": "..."}`. Direct manufacturing cases have both names. For standard cases the Hub stores one name field: `first_name` and `last_name` are `null` and `name` holds it. A cleared or removed name is `null` throughout. Each page that reveals names is one entry in your company's access log.

### Read one case

`GET /api/v1/cases/{key}` (scope `cases:read`). `{key}` is the Hub reference (`ACME-000412`) or your own case ID (URL encode spaces, `/` and `#`). If several cases share your ID, the newest one that is not cancelled is returned. The result is the case object plus files and events:

```json
{
  "ref": "ACME-000412",
  "case_id": "55813",
  "status": "shipped",
  "...": "all fields of the list",
  "files": [
    { "id": "0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11", "name": "upper/U01.stl", "kind": "stl", "arch": "upper", "step": 1, "template": false, "size": 20480123, "state": "ready", "sha256": "9f2b...e1" },
    { "id": "5d1f0e7a-....", "name": "upper/U01.pts", "kind": "pts", "arch": "upper", "step": 1, "template": false, "size": 14203, "state": "ready", "sha256": "31c4...0a" },
    { "id": "77aa....", "name": "other/document.pdf", "kind": "pdf", "arch": null, "step": null, "template": false, "size": 88123, "state": "ready", "sha256": "ab90...77" }
  ],
  "events": [
    { "type": "created", "at": "2026-09-21T08:14:02.311Z", "stage": null, "message": "Case created.", "source": "Partner" },
    { "type": "submitted", "at": "2026-09-21T08:40:55.010Z", "stage": null, "message": "Case submitted.", "source": "Partner" },
    { "type": "stage_reported", "at": "2026-09-22T06:30:00.000Z", "stage": "received", "message": "Stage: Received at factory.", "source": "Factory system" }
  ]
}
```

File `name` is the **canonical name** the Hub and K Line use: `upper/U01.stl`, `lower/L12_T.pts` (`_T` marks a template), `other/document.pdf`. It is never your original file name, because those can contain patient names. `state` is `uploading`, `processing`, `ready` or `rejected`; `sha256` is the checksum of the stored content. Event `message` is fixed wording per event type (it never repeats free text such as hold reasons or notes); `source` is `Partner`, `K Line`, `Factory system`, `K Line portal` or `System`. With `patients:read` the `patient` object is included and the read is logged.

### Create a case

`POST /api/v1/cases` (scope `cases:write`)

```bash
curl -s -X POST https://hub.example.com/api/v1/cases \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"case_id":"55813","patient_name":"Jane Example","instructions":"Please keep the attachments as designed.","priority":"normal","brand":"Smile Line"}'
```

| Field | |
|---|---|
| `case_id` | Your ID: letters, digits, spaces and `_ . / # -`, at most 64 characters, no `..`, and not starting or ending with a dot or a slash. Unique among your cases that are not cancelled (`409 case_id_exists`). |
| `patient_name` | Optional, stored encrypted, never printed on bags unless your bag layout says so. |
| `instructions` | Optional, up to 8,000 characters. Can be changed until production starts. |
| `priority` | `normal` (default) or `rush`. |
| `brand` | Optional name of one of your brands (set up in the Hub under Company profile). |

At least `case_id` or `patient_name` is needed. The answer is `201` with the case object (status `draft`; no `patient` key). Creating a case needs an approved company. Direct manufacturing cases (folders and zips of patients, pushed to the K Line portal) are created in the Hub's bulk upload, not through this API.

### Register a file, upload, check

See [Uploading files](#uploading-files-step-by-step). `POST /api/v1/cases/{key}/files` registers a file and returns how to send it; `GET /api/v1/files/{id}` tells you whether the checks are done.

### Submit a case

`POST /api/v1/cases/{key}/submit` (scope `cases:write`), body `{"acknowledge_warnings": true}` optional.

The same rules as in the web app. Errors block submitting (`409 checks_failed`, for example `no_stl`, `missing_mapping`, `duplicate_file`, `file_rejected`, `files_processing`). Warnings need an explicit yes: the first call answers `409 warnings_need_confirmation` with `warnings`; repeat it with `"acknowledge_warnings": true` and the acknowledgement is stored with the case. Only drafts and cases on hold can be submitted. Depending on your company's settings the case becomes `submitted` (K Line reviews it first) or goes straight to `ready` at your production site. The answer is the case object.

```json
{ "code": "warnings_need_confirmation", "message": "There are warnings. Please read and confirm them to continue.",
  "warnings": [ { "code": "missing_steps", "message": "The upper aligners are missing steps 2.", "arch": "upper" } ] }
```

### Shipments for invoicing

`GET /api/v1/shipments?from=2026-09-01&to=2026-09-30` (scope `cases:read`)

Cases that shipped in the period, by the **day of shipping in Europe/Berlin** (`shipped_at` between 00:00 on `from` and 24:00 on `to`). Both dates are required, `from` must not be after `to`, and the period is at most 366 days (`400 period_too_long`). Standard and direct manufacturing cases are included once they are shipped or delivered; cancelled cases never are. Oldest shipment first.

```json
{
  "items": [
    { "ref": "ACME-000398", "case_id": "55790", "shipped_at": "2026-09-12T14:20:00.000Z", "carrier": "DHL", "tracking_number": "JD014600003",
      "aligners_shipped": 26, "aligners_upper": 13, "aligners_lower": 13, "templates": 2, "mode": "standard", "kind": "new", "site": "PT-CHV" }
  ],
  "total": 1,
  "total_aligners": 26
}
```

`aligners_shipped` is the number the factory reported when it shipped. The K Line portal does not report a count for direct manufacturing cases; for those, `aligners_shipped` is `aligners_upper + aligners_lower`. `templates` are listed but are not part of `aligners_shipped`. `total_aligners` is the sum of `aligners_shipped`. A replacement or rework (`kind`) that ships in the period is listed like any other case.

### Claims

`GET /api/v1/claims?status=&from=&to=&page=&page_size=` (scope `claims:read`). `status` is `open`, `in_review`, `awaiting_partner`, `accepted`, `rejected`, `closed` or `active` (the first three). Claims are opened and discussed in the Hub; the API only lists them and has no free text.

```json
{ "items": [ { "number": "CLM-2026-00017", "case_ref": "ACME-000398", "status": "accepted", "resolution": "remake", "created_at": "2026-09-14T09:12:40.000Z", "item_count": 3 } ],
  "total": 1, "page": 1, "page_size": 25 }
```

`resolution` is `remake`, `credit`, `no_action`, `other` or `null`.

### Materials

`GET /api/v1/materials` (scope `materials:read`): the materials you supply to K Line (boxes, bags and so on) and the stock per K Line site.

```json
{ "items": [ { "sku": "BOX-1", "name": "Case box", "category": "box", "unit": "pieces", "per_case": 1, "per_aligner": 0, "min_stock": 200, "active": true,
    "stock": [ { "site": "PT-CHV", "on_hand": 340, "in_transit": 500, "used_28d": 410, "days_of_cover": 23.2, "low_stock": false } ] } ] }
```

`days_of_cover` is on hand divided by the daily use of the last 28 days (`null` when nothing was used). `low_stock` is true when `on_hand` is below `min_stock`.

## Uploading files step by step

Files go up in chunks of 8 MB so large models survive bad connections, and every chunk carries its own checksum. A file of 8 MB or less is one chunk. The steps:

1. **Register** the file: `POST /api/v1/cases/{key}/files` with `{"name": "U01.stl", "size": 20480123}`. Optional `arch` (`upper` or `lower`), `step` (0 to 999), `template` (true for a template). For STL, PTS and CSV files the arch, step and template flag are read from the name (`U01.stl`, `L12.pts`, `U01_T.stl`, `55813_U01.stl`); send them only to override, or send `null` for "none". The answer:
   ```json
   { "file_id": "0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11", "chunk_size": 8388608, "chunk_count": 3, "received": [], "state": "uploading" }
   ```
   Registering the same name and size again **resumes**: `received` lists the chunks the Hub already has.
2. **Send every chunk that is not in `received`**: `PUT /api/uploads/{file_id}/chunks/{index}` (index from 0) with the raw bytes, `Content-Type: application/octet-stream` and the header `x-chunk-sha256: <hex SHA-256 of exactly these bytes>`. All chunks are 8,388,608 bytes except the last one. A damaged chunk answers `422 checksum_mismatch`; send it again (sending a chunk again replaces it). The answer is `{"received": <how many chunks are stored>}`. Chunks can go in any order and in parallel.
3. **Complete**: `POST /api/uploads/{file_id}/complete` with `{}`. If chunks are missing the answer is `409 upload_incomplete` with `missing`. Otherwise `{"state": "processing"}`; calling it again is harmless.
4. **Wait for the checks**: the Hub scans the file and checks the model (closed surface, trim line, units and so on). Poll `GET /api/v1/files/{file_id}` until `state` is `ready` or `rejected`. `errors` and `warnings` list fixed-text findings. A few seconds per file is normal; very large STLs take longer.
5. When all files are `ready`, [submit](#submit-a-case).

Files can be added while the case is a `draft` or `on_hold`. Limits: 512 MB per file, 600 files per case. Allowed types: `stl`, `pts`, `pdf`, `csv`, `svg`, `txt`, `xml`, `json`, `jpg`, `jpeg`, `png`. Programs and scripts are always refused (`415`). Every upload is written to your access log with the key as the actor.

### curl

```bash
BASE=https://hub.example.com
KEY=kph_0123456789ab_...
REF=ACME-000412
FILE=U01.stl
SIZE=$(stat -c %s "$FILE")

# 1. register
curl -s -X POST "$BASE/api/v1/cases/$REF/files" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"$FILE\",\"size\":$SIZE}" | tee reg.json
ID=$(jq -r .file_id reg.json)

# 2. send the chunks (here: one chunk; for larger files cut with `split -b 8388608 -d "$FILE" part_` and repeat per part with index 0, 1, 2 ...)
SHA=$(sha256sum "$FILE" | cut -d' ' -f1)
curl -s -X PUT "$BASE/api/uploads/$ID/chunks/0" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/octet-stream" -H "x-chunk-sha256: $SHA" --data-binary @"$FILE"

# 3. complete
curl -s -X POST "$BASE/api/uploads/$ID/complete" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}'

# 4. poll
curl -s "$BASE/api/v1/files/$ID" -H "Authorization: Bearer $KEY" | jq '{name, state, errors, warnings}'
```

### Node.js (22 or newer)

```js
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

const BASE = process.env.HUB_URL;           // https://hub.example.com
const KEY = process.env.HUB_API_KEY;
const auth = { authorization: `Bearer ${KEY}` };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...auth, ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.message ?? res.statusText), { status: res.status, code: json?.code, body: json });
  return json;
}

export async function uploadFile(caseKey, path, name) {
  const size = (await stat(path)).size;
  const reg = await call('POST', `/api/v1/cases/${encodeURIComponent(caseKey)}/files`, { name, size });
  const fh = await open(path, 'r');
  try {
    for (let i = 0; i < reg.chunk_count; i++) {
      if (reg.received.includes(i)) continue;                     // resume
      const buf = Buffer.alloc(Math.min(reg.chunk_size, size - i * reg.chunk_size));
      await fh.read(buf, 0, buf.length, i * reg.chunk_size);
      const sha = createHash('sha256').update(buf).digest('hex');
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${BASE}/api/uploads/${reg.file_id}/chunks/${i}`, {
          method: 'PUT',
          headers: { ...auth, 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha },
          body: buf,
        });
        if (res.ok) break;
        if (attempt >= 3 || res.status < 500 && res.status !== 422) throw new Error(`chunk ${i} failed: ${res.status}`);
      }
    }
  } finally {
    await fh.close();
  }
  await call('POST', `/api/uploads/${reg.file_id}/complete`, {});
  for (;;) {                                                      // wait for the checks
    const f = await call('GET', `/api/v1/files/${reg.file_id}`);
    if (f.state === 'ready') return f;
    if (f.state === 'rejected') throw new Error(`rejected: ${f.errors.map((e) => e.message).join(' ')}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// const c = await call('POST', '/api/v1/cases', { case_id: '55813', patient_name: 'Jane Example' });
// await uploadFile(c.ref, './U01.stl', 'U01.stl');
// await call('POST', `/api/v1/cases/${c.ref}/submit`, { acknowledge_warnings: false });
```

## Webhooks

Webhooks tell your system when something changes, so you do not have to poll. They are created in the Hub under **ERP and API, Webhooks** by someone with `integration.manage` (no partner role has it at the moment): an `https` address, the events you want, an optional description. The secret (`whsec_...`) is shown once at creation and again only when it is rotated. Up to 10 webhooks per company. Use **Send test** to check your endpoint before real events arrive.

### Events

| Event | Sent when |
|---|---|
| `case.submitted` | A case is submitted (by you, your key, or as a replacement or rework order). |
| `case.on_hold` | K Line or the factory puts a case on hold. The reason is not in the event: read the case. |
| `case.received` | The factory system acknowledges the case. |
| `case.stage_changed` | The case reaches a later factory stage, or a direct manufacturing case enters production. |
| `case.shipped` | The case ships. Includes carrier, tracking number and aligners shipped. |
| `case.delivered` | The case is marked delivered. |
| `case.cancelled` | The case is cancelled, by you or by K Line. |
| `claim.updated` | A quality claim is opened, changes status, is decided or closed. |
| `materials.low_stock` | A material you supply falls below its minimum at a K Line site. |
| `spec.updated` | Your production specification is proposed, signed, activated or rejected. |

Internal steps such as routing a case to a production site are not events. Each event type is sent only to the webhooks subscribed to it.

### The request

A `POST` with a JSON body and these headers:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `user-agent` | `KPH-Webhooks/1` |
| `x-kph-event` | The event type, for example `case.shipped`. |
| `x-kph-delivery` | The delivery id. The same id is used again for every retry of the same event and endpoint: use it to **ignore duplicates**. |
| `x-kph-signature` | `t=<unix seconds>,v1=<hex>`, see below. |

Body:
```json
{
  "id": "6f1d6f0a-6a39-4d1c-9a4e-0d3c8d3d2a77",
  "type": "case.shipped",
  "created_at": "2026-09-24T13:05:41.120Z",
  "org_code": "ACME",
  "data": {
    "ref": "ACME-000412",
    "case_id": "55813",
    "status": "shipped",
    "simple_status": "shipped",
    "stage": "shipped",
    "stage_label": "Shipped",
    "site": "PT-CHV",
    "carrier": "DHL",
    "tracking_number": "JD014600003",
    "aligners_shipped": 24
  }
}
```

Other `data` shapes: `case.*` events have `ref, case_id, status, simple_status, stage, stage_label, site` (and the shipping fields once shipped). `claim.updated`: `{"claim_number": "CLM-2026-00017", "case_ref": "ACME-000398", "status": "accepted", "resolution": "remake"}` (`resolution` only once decided). `materials.low_stock`: `{"sku": "BOX-1", "site": "PT-CHV", "on_hand": 120, "min_stock": 200}`. `spec.updated`: `{"version": 3, "status": "proposed"}`.

Webhooks carry **references and counts only**: never patient names, instructions, notes, hold reasons, file names or claim text. `case_id` is the ID you gave the case (for direct manufacturing cases that is the patient ID, so treat it as personal data in your own logs). To get anything more, call the API with the `ref`.

### Verifying the signature

Every request is signed with your endpoint's secret so that you know it came from the Hub and was not changed. `v1` is the hex HMAC-SHA256 of the text `"<t>.<raw request body>"`, where `t` is the number in the header, and the key is the **whole secret string including the `whsec_` prefix**. Compute it over the **raw body bytes** exactly as received (before any JSON parsing), compare in constant time, and **reject timestamps older than 5 minutes** to stop replays. Answer with any `2xx` quickly and do the work afterwards.

Node.js:
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyKlineWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;       // too old (or from the future)
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Express: app.post('/kline', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyKlineWebhook(req.body, req.get('x-kph-signature'), process.env.KLINE_WEBHOOK_SECRET)) return res.sendStatus(400);
//   const event = JSON.parse(req.body); /* de-duplicate on event.id, then process */ res.sendStatus(204); });
```

Python:
```python
import hashlib, hmac, re, time

def verify_kline_webhook(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    m = re.fullmatch(r"t=(\d+),v1=([0-9a-f]{64})", header or "")
    if not m:
        return False
    t = int(m.group(1))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m.group(2))

# Flask: verify_kline_webhook(request.get_data(), request.headers.get("x-kph-signature", ""), SECRET)
```

### Delivery, retries and failures

* Your endpoint has **10 seconds** to answer. Any `2xx` counts as delivered. Anything else counts as failed: other status codes, timeouts, connection or certificate errors. **Redirects are not followed** (a `301` or `302` is a failure): give the final address.
* Failed deliveries are retried after **1, 5, 30, 120, 360, 720 and 1440 minutes**: 8 attempts in all, then the delivery is marked `dead`. Every attempt has a fresh signature timestamp; the delivery id and the body stay the same.
* After **25 failed attempts in a row** the webhook is switched off. The people with `integration.manage` get a notice in the Hub and an email. Fix the endpoint, switch the webhook back on, and resend missed events from the delivery history. A success resets the count.
* The delivery history (status, attempts, last status code, a short fixed-text error, the exact payload) is kept for 90 days, with a **Retry** button per delivery.
* Events from one company are not guaranteed to arrive in order, especially after retries: use `created_at` and the current state of the case (`GET /api/v1/cases/{ref}`) when order matters. Answer `2xx` for events you do not care about.
* Your endpoint must be reachable from the public internet over https with a valid certificate. For your protection and ours the Hub refuses to connect to private or internal addresses: loopback, private ranges (10.x, 172.16 to 31.x, 192.168.x), link-local and cloud metadata (169.254.x), carrier-grade NAT (100.64 to 127.x), multicast and reserved ranges, and IPv6 equivalents. Host names are resolved again at every connection, so a name that later points to an internal address is refused as well. Addresses with a user name or password, and plain `http`, are not accepted. On a developer's own test installation (never in production) `http://localhost` is allowed.
* If your firewall only lets known addresses through, ask K Line support for the addresses the Hub sends webhooks from.

## CSV exports

For finance and reporting, people (not keys) with the `export.run` permission can download CSV files in the Hub under **ERP and API, Exports**, or directly: `GET /api/exports/cases.csv?from=2026-09-01&to=2026-09-30` and `GET /api/exports/shipments.csv?...` (signed-in session; for scripts use the API above). `include_names=1` adds the patient names and needs a separate permission and a fresh authenticator code; the export is logged as a bulk name reveal with the number of rows. Files hold at most 100,000 rows. Cells that could be read as spreadsheet formulas get a leading apostrophe.

## Limits and good behaviour

* **Rate limit**: 900 requests per minute per key. Answers carry `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`; past the limit you get `429 rate_limited` and should wait. Chunk uploads have a much higher limit.
* **Polling**: for status, prefer webhooks, or poll `GET /api/v1/cases?updated_since=<last updated_at>` every minute or so instead of reading every case.
* **Retries**: retry `5xx`, `429` and network errors with exponential backoff. Do not retry `4xx` (other than `422` for a damaged chunk) without changing the request.
* Keep keys in a secret store, give each system its own key with the fewest scopes and a short expiry, and add the IP allow list.

## Changelog

* **2026-09** First version of the partner API: cases (list, read, create, files, submit), shipments for invoicing, claims, materials, API keys with scopes, IP allow list and expiry, webhooks with signed deliveries and retries, CSV exports.
