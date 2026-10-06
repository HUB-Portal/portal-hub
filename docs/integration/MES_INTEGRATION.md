# Portal Hub: factory system (MES) integration

This guide is for the people who connect a K Line factory system (MES, production planning, label printing) to the Portal Hub. The Hub is where partner companies send cases and where K Line checks and approves them. **The factory system is the source of truth for production**: it pulls approved cases, reports back what happens to each one, and the Hub shows that to the partner.

Base URL: the address of your Hub, for example `https://hub.example.com`. All calls below are under `/api/mes/v1`.

Contents: [Service keys](#service-keys) · [How the flow works](#how-the-flow-works) · [Pulling cases](#1-pull-cases-to-make-get-intake) · [Downloading files](#2-download-files-get-filesid) · [Acknowledging](#3-acknowledge-a-case-post-casesrefack) · [Reporting events](#4-report-events-post-events) · [Stage map](#the-stage-map) · [CSV import](#csv-import-of-events) · [Errors](#errors) · [Examples](#examples)

## Service keys

The factory system signs in with a **service key**, created by a K Line administrator in the console under **Service keys** (permission `admin.mes`, with an authenticator code). Give each system its own key, pick only the scopes it needs, set an expiry (at most 730 days) and, if you can, a list of allowed IP addresses or CIDR ranges. The key (`kph_<12 hex>_<43 characters>`) is shown once.

Send it on every call: `Authorization: Bearer kph_...`.

| Scope | Allows |
|---|---|
| `mes:intake` | `GET /intake`, `POST /cases/{ref}/ack` |
| `mes:files` | `GET /files/{id}` |
| `mes:events` | `POST /events`, `GET /stage-map` |

Rules that are checked on every call:

* Only a K Line service key with the right scope works. Sessions (people) and partner API keys get `403`; no key or a bad, revoked or expired key, or a call from an address outside the key's list, gets `401`.
* Service keys never work on partner routes, and partner keys never work here.
* Every file the factory system downloads is written to that partner's access log as done by "K Line service", so partners can see what the factory system accessed. A poll of `GET /intake` is written as one entry per call to K Line's own log (how many cases and up to 20 references).
* Rate limit: 900 calls a minute per key. Answers carry `x-ratelimit-*` headers and an `X-Request-Id`.

Errors have the status code and `{"code": "...", "message": "..."}`.

## How the flow works

```
partner uploads files -> Hub checks them -> partner submits -> K Line reviews (or automatic)
  -> status "ready" at a production site (e.g. PT-CHV)
  -> MES: GET /intake          (pull ready cases for your site)
  -> MES: GET /files/{id}      (download each file, verify sha256)
  -> MES: POST /cases/{ref}/ack (status "received")
  -> MES: POST /events          (PRINT, THERMO, QC, PACK, SHIP with tracking, ...)
  -> the partner sees the progress; webhooks and emails go out
```

* Only **standard** cases are pulled by the factory system. Direct manufacturing cases are produced through the K Line customer portal; events for them are errors (`direct_case`).
* A case is offered in `GET /intake` while its status is `ready`. After the acknowledgement it is `received` and no longer listed.
* The partner may put a case back on hold or cancel it while it is still with K Line; report what happens with events (below).
* Patient names are **never** sent to the factory system. Partner file names are not sent either (they may contain names): files carry canonical names.

## 1. Pull cases to make: `GET /intake`

Scope `mes:intake`. Query: `site` (a site code such as `PT-CHV`; all sites when left out), `limit` (1 to 200, default 100). Cases with status `ready` routed to the site, **oldest first**.

```bash
curl -s "https://hub.example.com/api/mes/v1/intake?site=PT-CHV&limit=50" -H "Authorization: Bearer $KEY"
```
```json
{
  "cases": [
    {
      "ref": "ACME-000412",
      "partner": { "code": "ACME", "name": "Acme Aligners" },
      "partner_case_id": "55813",
      "kind": "new",
      "parent_ref": null,
      "priority": "normal",
      "site": "PT-CHV",
      "ready_at": "2026-09-21T09:02:17.004Z",
      "expected_ship_date": "2026-09-24",
      "spec_version": 3,
      "claim_number": null,
      "brand": "Smile Line",
      "notes": "Please keep the attachments as designed.",
      "acknowledged_warnings": [],
      "aligner_counts": { "upper": 12, "lower": 12, "templates": 2 },
      "items": [],
      "files": [
        {
          "id": "0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11",
          "name": "upper/U01.stl",
          "kind": "stl", "arch": "upper", "step": 1, "template": false,
          "requested": true,
          "bytes": 20480123,
          "sha256": "9f2b6c...e1",
          "download_url": "https://hub.example.com/api/mes/v1/files/0c9a5b38-1d04-4f0a-8b74-7a6e2a8f1c11"
        }
      ],
      "bags": [ { "aligner": "U01", "arch": "upper", "step": 1, "lines": ["Smile Line", "55813", "U01 Upper", "Step 1 of 12", "Wear for 14 days"], "barcode": "ACME-000412 U01" } ],
      "bag_personal_data": false
    }
  ]
}
```

Fields:

* `ref`: the Hub reference. Use it in every other call. `partner_case_id` is the partner's own ID (may be null). `parent_ref` is set for replacement and rework cases.
* `priority`: `normal` or `rush`. `expected_ship_date`: planned shipping day (`YYYY-MM-DD`).
* `spec_version`: the version of the partner's production specification that applies (null when the partner has none). `claim_number`: set on rework cases made for a quality claim.
* `notes`: the partner's instructions, decrypted and passed on **as written**. Treat them as free text from a person.
* `acknowledged_warnings`: the warnings the partner confirmed when submitting (empty when there were none).
* `aligner_counts`: distinct aligner steps per arch; templates are counted separately. For a replacement or rework these count only the requested aligners.
* `items`: empty for a new case (everything is required). For a replacement or rework it lists the aligners to make: `{"aligner": "U02", "arch": "upper", "step": 2, "template": false, "defect_code": "SCRATCHES"}` (`U01_T` for a template; `defect_code` only for claims).
* `files`: every file that passed the checks (`state` ready). `name` is the **canonical name**: `upper/U01.stl`, `upper/U01.pts` (trim line), `lower/L12_T.stl` (`_T` = template), `other/document.pdf` for anything not tied to an aligner. `bytes` is the size and `sha256` the checksum of the content. `requested` is `false` for files of a replacement or rework case that belong to aligners not in `items` (the case carries its parent's files; make only what `items` asks for). Files without an arch and step are always `requested: true`.
* `bags`: the bag label content per aligner, from the partner's layout in the active specification: `lines` (text lines), `barcode` (the text to encode; the printer system does the Code 128 encoding). Templates have no bags. `bag_personal_data: true` means the layout would print patient data; the Hub never sends names, so those tokens are empty.

Each call is logged once (`mes.intake_read`, in K Line's own log: the number of cases and up to 20 references).

## 2. Download files: `GET /files/{id}`

Scope `mes:files`. `id` is the file `id` from the intake. The answer is the decrypted file as an attachment, `Content-Disposition` with the canonical file name (`U01.stl`), `Content-Type: application/octet-stream`, `Content-Length` set, no caching.

```bash
curl -s -o U01.stl -D - "https://hub.example.com/api/mes/v1/files/0c9a5b38-..." -H "Authorization: Bearer $KEY"
sha256sum U01.stl        # must equal "sha256" from the intake
```

* **Always verify the SHA-256** against the intake value. Every stored chunk is integrity-protected; a file that cannot be read back cleanly answers `500 file_unreadable` instead of sending damaged bytes.
* Only files in state `ready` of **standard** cases whose status is `ready`, `received` or `in_production` and that are routed to a site can be downloaded. Anything else is `404` (a file of a case that was put on hold or cancelled disappears), `409 file_not_available` for a file that is not ready.
* Each download is logged to the partner as a K Line access (`file.download`, via the factory system).

## 3. Acknowledge a case: `POST /cases/{ref}/ack`

Scope `mes:intake`. Body `{"mes_case_id": "MES-88231"}`: the factory system's own case number (1 to 64 characters of letters, digits and `_ . : / # -`). Moves the case from `ready` to `received` (stage `received`) and stores the number.

```json
{ "ok": true, "already": false, "status": "received" }
```

* Repeating the call with the same number is harmless (`already: true`).
* `409 mes_case_id_mismatch`: the case already has a different number. `409 mes_case_id_taken`: the number belongs to another case. `409 case_not_ready`: the case is not `ready` (put on hold, cancelled, or already further along with another number). `409 not_standard`: a direct manufacturing case. Unknown reference: `404`.
* The partner is notified (bell and, if they want, email) and their webhooks receive `case.received`.

## 4. Report events: `POST /events`

Scope `mes:events`. Send what happens to cases as a list, in the order it happened, **at most 500 events per call** (`400 too_many_events`).

```json
{ "events": [
  { "event_id": "MES-EVT-900001", "case_ref": "ACME-000412", "stage_code": "PRINT", "occurred_at": "2026-09-22T07:15:00Z" },
  { "event_id": "MES-EVT-900002", "mes_case_id": "MES-88231", "stage_code": "SHIP", "occurred_at": "2026-09-23T15:40:00Z",
    "carrier": "DHL", "tracking_number": "JD014600003", "aligners_shipped": 24 },
  { "event_id": "MES-EVT-900003", "partner_code": "ACME", "partner_case_id": "55790", "stage_code": "HOLD", "occurred_at": "2026-09-23T16:00:00Z",
    "hold_reason": "Model file for step 4 is damaged. Please send it again." }
] }
```

| Field | |
|---|---|
| `event_id` | **Required, your unique ID** for this event (up to 100 characters). This makes the call idempotent (see below). |
| `case_ref` or `mes_case_id` or `partner_code` + `partner_case_id` | How to find the case. Use the Hub reference when you can. A partner case ID that matches more than one live case is an error. |
| `stage_code` | Your code for the event, mapped by the [stage map](#the-stage-map). Case does not matter. |
| `occurred_at` | ISO 8601 time. A time in the future is treated as now. A time more than 24 hours before the case was created in the Hub, or more than 3 years ago, is an `error` ("The time is not plausible for this case."): fix the time and send the same event again. |
| `carrier`, `tracking_number`, `aligners_shipped` | **Required for a shipping event** (`SHIP`): carrier up to 60 characters, tracking number up to 100, aligners shipped 1 to 5,000. |
| `hold_reason` | For holds. Shown to the partner. Without one, the partner sees "The factory has put this case on hold. K Line will be in touch." |

The answer has one result per event, in the order sent:

```json
{ "results": [
  { "event_id": "MES-EVT-900001", "outcome": "applied" },
  { "event_id": "MES-EVT-900002", "outcome": "applied" },
  { "event_id": "MES-EVT-900003", "outcome": "error", "message": "The case could not be found." }
] }
```

`outcome` is:

* `applied`: the case changed.
* `ignored`: valid but nothing to do, with a `message` (the case is already at or past that stage, already on hold, already shipped, cancelled, or the stage code is set to `ignore` in the map). Do not resend.
* `duplicate`: this `event_id` was already applied or ignored earlier. Safe to send again; nothing happens twice.
* `error`: the event could not be used (unknown stage code, unknown case, missing shipping details, case not with the factory yet, a direct manufacturing case, a factory case number clash, invalid time or a time that is not plausible for the case). **An error does not use up the `event_id`**: fix the cause and send the same event again. Messages never repeat what you sent.

Events are processed one by one, each in its own transaction, so a bad event never blocks the others.

### Idempotency and ordering

* Retry whole calls freely after a timeout: events that were applied come back as `duplicate`.
* **Stages only move forward.** A stage older than or equal to the case's current one is `ignored` ("The case is already at or past that stage."). After a hold is released, a case has no current stage, so any stage is allowed again.
* **`DELIVERED` needs `SHIP` first.** `DELIVERED` for a case that has not shipped is `ignored` ("Send SHIP before DELIVERED."), never applied: a case is only ever delivered after `SHIP` has recorded the carrier, the tracking number and the aligners shipped. Send `SHIP`, then `DELIVERED`.
* Status follows the stage: `received` is status `received`; `printing` to `packing` are `in_production`; `shipped` and `delivered` are `shipped` and `delivered`.
* A stage for a case that is still a draft, submitted or on hold is an `error` (`case_not_in_production`); for a cancelled case it is `ignored`.
* `HOLD` works from submitted, ready, received and in production; a second hold or a hold on a shipped or delivered case is `ignored`. `CANCEL` works until the case ships.
* A case that the factory put on hold goes back to K Line when the partner submits it again (status `submitted`, not `ready`): K Line approves it again and it appears in `GET /intake` once more.
* Each applied event updates the case, adds an entry to its timeline ("Factory system"), notifies the partner and sends the partner's webhooks (`case.on_hold`, `case.received`, `case.stage_changed`, `case.shipped`, `case.delivered`, `case.cancelled`). A shipping event also records the shipment, sets the date from which the partner's retention period runs, and books the partner's supplied materials used for the case.

## The stage map

Your codes are translated into Hub stages by a map that K Line edits in the console (**MES integration, stage map**). Read it with `GET /stage-map` (scope `mes:events`):

```json
{ "stage_map": [ { "code": "PRINT", "target": "printing", "note": "" }, { "code": "SHIP", "target": "shipped", "note": "" } ] }
```

A code's `target` is a stage, `hold`, `cancelled` or `ignore`. The default map:

| Code | Target | | Code | Target |
|---|---|---|---|---|
| `RECEIVED`, `CAD` | `received` | | `QC` | `quality_check` |
| `PRINT`, `POSTPRINT` | `printing` | | `PACK` | `packing` |
| `THERMO` | `thermoforming` | | `SHIP` | `shipped` |
| `TRIM`, `LASER` | `trimming` | | `DELIVERED` | `delivered` |
| `POLISH`, `CLEAN` | `finishing` | | `HOLD` | `hold` |
| | | | `CANCEL` | `cancelled` |

Stages in order: `received` (Received at factory), `printing` (3D printing), `thermoforming`, `trimming`, `finishing` (Finishing and cleaning), `quality_check`, `packing`, `shipped`, `delivered`. An unknown code is an `error` and is logged in the console's event log, so K Line can add it to the map; then resend the same event.

## CSV import of events

If the factory system cannot call the API, K Line staff can import events from a CSV file in the console (**MES integration, import**; permission `admin.mes`). It uses the same rules and the same stage map.

* UTF-8, comma separated, first row is the header, up to 5,000 rows and 5 MB. Quote cells that contain commas, double the quotes inside.
* Columns (by name, any order): `event_id, case_ref, partner_code, partner_case_id, mes_case_id, stage_code, occurred_at, carrier, tracking_number, aligners_shipped, hold_reason`. `stage_code` and `occurred_at` are required.
* A blank `event_id` becomes `csv:` plus a hash of the row, so importing the same file twice changes nothing.
* The result lists an outcome per row (`applied`, `ignored`, `duplicate`, `error`) with the row number counted from the header as row 1.

```csv
event_id,case_ref,stage_code,occurred_at,carrier,tracking_number,aligners_shipped,hold_reason
,ACME-000412,PRINT,2026-09-22T07:15:00Z,,,,
,ACME-000412,SHIP,2026-09-23T15:40:00Z,DHL,JD014600003,24,
,ACME-000398,HOLD,2026-09-23T16:00:00Z,,,,"Step 4 model is damaged, please send it again"
```

## Errors

| Status | `code` | Meaning |
|---|---|---|
| 401 | `invalid_api_key`, `unauthenticated` | No key, or a wrong, revoked, expired key or address. |
| 403 | `forbidden` | Not a K Line service key, or the key lacks the scope. |
| 400 | `invalid_request`, `too_many_events` | Bad body or query. |
| 404 | `not_found` | Unknown case or file, or not available to the factory system. |
| 409 | `case_not_ready`, `mes_case_id_mismatch`, `mes_case_id_taken`, `not_standard`, `file_not_available` | See the calls above. |

In the answer to `POST /events`, a rejected time reads `{"outcome": "error", "message": "The time is not plausible for this case."}` and `DELIVERED` before `SHIP` reads `{"outcome": "ignored", "message": "Send SHIP before DELIVERED."}`.
| 429 | `rate_limited` | Wait and retry with backoff. |
| 500 | `file_unreadable` | A stored file failed its integrity check. Tell K Line support. |

## Examples

### A polling loop (Node.js 22)

```js
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.HUB_URL;
const auth = { authorization: `Bearer ${process.env.HUB_SERVICE_KEY}` };

async function hub(method, path, body) {
  const res = await fetch(BASE + '/api/mes/v1' + path, {
    method,
    headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${(await res.text()).slice(0, 200)}`), { status: res.status });
  return res;
}

async function pullCases(site) {
  const { cases } = await (await hub('GET', `/intake?site=${site}&limit=50`)).json();
  for (const c of cases) {
    for (const f of c.files.filter((x) => x.requested)) {
      const res = await fetch(f.download_url, { headers: auth });
      if (!res.ok) throw new Error(`download ${f.name}: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error(`checksum mismatch for ${f.name}`);
      await writeFile(`./jobs/${c.ref}/${f.name.replaceAll('/', '_')}`, bytes);     // your own storage
    }
    await hub('POST', `/cases/${c.ref}/ack`, { mes_case_id: await createWorkOrder(c) });  // your own work order number
  }
}

async function report(events) {
  for (let i = 0; i < events.length; i += 500) {
    const { results } = await (await hub('POST', '/events', { events: events.slice(i, i + 500) })).json();
    for (const r of results) if (r.outcome === 'error') console.warn('event not accepted', r.event_id, r.message);
  }
}
```

### Shipping a case

```bash
curl -s -X POST https://hub.example.com/api/mes/v1/events -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "events": [{ "event_id": "WO-88231-SHIP", "case_ref": "ACME-000412", "stage_code": "SHIP",
               "occurred_at": "2026-09-23T15:40:00Z", "carrier": "DHL", "tracking_number": "JD014600003", "aligners_shipped": 24 }] }'
```

### Good practice

* Poll `GET /intake` every minute or two per site, not faster. Make `event_id` a value you can always regenerate for the same event (your event table's primary key), so that retries are duplicates.
* Verify every checksum; keep the canonical names; never try to match cases by patient name (the Hub does not send names).
* Report `SHIP` only when the parcel leaves, with the real carrier and tracking number: the partner sees them, and the shipment feeds the partner's invoicing.
* When the stage map lacks a code, the console shows the `error` events. K Line adds the code and you resend the same events.
