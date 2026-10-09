# Phase 2 API contract (intake and direct manufacturing bulk)

Status: implemented and tested on the server (server/src/routes/{uploads,files,cases,bulk,orgPortal}.ts). This file matches the code.

All routes under `/api`, JSON, session cookie auth plus `x-csrf-token` on writes (see BRIEF section 6). Partner API keys work on the routes marked "key" with scopes `cases:read` (case.read, file.download), `cases:write` (case.write) and `patients:read` (case.reveal_name). Errors are `{code, message, ...extra}` with the HTTP status. Permissions in brackets. IDs are UUIDs. Times ISO 8601. Send `{}` as the body of POST requests without data.

Case shape returned by list and detail (patient names never in list rows, only masked):

```
Case {
  id, ref ("ACME-000001"), caseId (partner case id or patient ID, may be null), status, stage, kind, priority,
  manufacturingMode: "standard" | "direct",
  patientMasked: string | null            // "M*** A*****" (first letter kept), null if none
  hasPatientName: boolean,
  hasInstructions: boolean,
  instructionsLocked: boolean,            // true once production has started
  brandId, siteCode, dueDate ("YYYY-MM-DD"), holdReason,
  counts: { upper, lower, templates, shipped },   // upper/lower = distinct aligner steps (templates excluded)
  fileCount,
  checks: { errors: Issue[], warnings: Issue[] },
  warningsAcknowledged: boolean,
  portal: { status: "not_applicable"|"pending"|"pushing"|"pushed"|"failed", caseUuid?: string, attempts: number, lastError?: string },
  bulkBatchId: string | null,
  orgId, orgName,                          // useful for K Line users; partners only ever see their own
  createdAt, submittedAt, readyAt, receivedAt, shippedAt, deliveredAt, cancelledAt, updatedAt
}
Issue { code, message, fileId?, arch?, step? }
File { id, caseId, kind, arch, step, template, name (decrypted original name), ext, size, state, scan, validation: {errors, warnings, meta}, createdAt }
Event { id, type, actorType, data, createdAt }
```

`File.state`: `uploading | processing | ready | rejected`. `scan`: `pending | clean | infected | error | skipped` (`skipped` when the scanner driver is `none`). `validation.meta` holds the checks' measurements (STL: `format, triangles, vertices, bbox{min,max,size}, openEdges, nonManifoldEdges, zeroAreaTriangles, edgeAnalysis`; PTS: `points, declaredCount, closed, gapMm, medianSegmentMm, breaks, bbox{min,max}`; CSV: `rows, columns, utf8`) plus `sha256` of the decrypted content.

Check issue codes: errors `no_stl`, `missing_mapping`, `duplicate_file`, `file_rejected`, `files_processing`, `files_incomplete`; warnings `missing_pts` (only with the org setting `require_pts`, aligners only, not templates), `trim_without_model`, `missing_steps`, `trim_outside_model`, plus each file's own warnings under their codes (`stl_units`, `stl_open_edges`, `stl_non_manifold`, `stl_zero_area`, `pts_open`, `pts_break`, `pts_few_points`, `pts_count_mismatch`, `pts_some_unreadable`, `csv_formula`, `csv_encoding`, `pdf_embedded_files`, `pdf_encrypted`). Template files (`U01_T`, template flag) are their own slot and never clash with the aligner of the same step.

## Cases

* `GET /api/cases?search=&status=attention|production|done|draft&mode=standard|direct&orgId=&page=1&pageSize=25` [case.read, key]. `orgId` only has an effect for K Line users. Search matches case ID or reference (substring, case insensitive), or the exact patient name (blind index; both name orders for direct cases; case, accents, spacing and punctuation ignored). `pageSize` at most 100. Returns `{items: Case[], total, page, pageSize}`, newest first. `attention` = on hold, portal push failed, or a draft/submitted case with a rejected file. `production` = submitted, ready, received, in production. `done` = shipped, delivered.
* `POST /api/cases` [case.write, key] `{caseId?, patientName?, brandId?, priority?, instructions?}` creates a standard draft, returns 201 `{case}`. At least one of caseId or patientName (`identifier_required`). Case ID rules: letters, digits, spaces and `_ . / # -`, at most 64 characters (`invalid_case_id`). 409 `case_id_exists` (unique per partner among not cancelled new standard cases, case insensitive). Only partner organisations can create cases (K Line gets 403).
* `GET /api/cases/:id` [case.read, key] returns `{case, files: File[], events: Event[], instructions: string | null}` (instructions decrypted).
* `PATCH /api/cases/:id` [case.write, key] `{caseId?, patientName?, firstName?, lastName?, brandId?, priority?, instructions?}`. `caseId, patientName, firstName, lastName (direct only), brandId, priority` only in draft or on_hold (else 409 `case_not_open`). `instructions` in draft, submitted, on_hold, ready (else 409 `instructions_locked`), at most 8,000 characters (400 `instructions_too_long`); after submission it adds an `instructions_updated` event and notifies K Line intake by case reference only. Returns `{case}`.
* `POST /api/cases/:id/submit` [case.write, key] `{acknowledgeWarnings?: boolean}` returns `{case}`. Draft or on_hold only (409 `case_not_open`). 403 `org_not_approved` when the organisation is not active or has no DPA. 409 `checks_failed` with `errors: Issue[]`; 409 `warnings_need_confirmation` with `warnings: Issue[]`. Transfer gate: 403 `transfer_blocked` when no allowed site may legally receive the case (EEA partner, non EEA site without adequacy or SCCs on file); 409 `no_site_configured` when the organisation has no site and manual review is off. With org setting `manual_review` the case becomes `submitted` (no site, no due date, K Line is notified); otherwise `ready` at the default site or the first allowed site that may receive it, `dueDate` = `sla_days` (default 3) business days after today. Warnings acknowledgement is stored. From on_hold the event is `resubmitted`. Direct cases set `portal.status = pending` and enqueue `bulk.push`.
* `POST /api/cases/:id/cancel` [case.write, key] draft, submitted, on_hold or ready only (409 `cannot_cancel`). Frees the case ID. Returns `{case}`.
* `DELETE /api/cases/:id` [case.write, key] draft only (409 `case_not_draft`); removes files and stored chunks. Returns `{ok:true}`.
* `POST /api/cases/:id/reveal-name` [case.reveal_name, key] audited (`case.name_revealed`, org = the case's organisation): `{patientName, firstName, lastName}` (first and last are null for standard cases).
* `GET /api/cases/:id/package.zip` [file.download, key] streamed zip of ready files: canonical names (`upper/U01.stl`, `upper/U01.pts`, `lower/L12_T.stl`, `other/<name>`), `manifest.csv` (`path,kind,arch,step,template,size,sha256`), `instructions.txt`. Audited as `case.package_downloaded`.
* `GET /api/files/:id/download` [file.download, key] decrypts and streams a ready file with `Content-Disposition: attachment`, `nosniff`, `no-store`; audited as `file.download` against the case's organisation (partners see K Line staff access, shown as "K Line staff"). 409 `file_not_available` unless the file is `ready`. 500 `file_unreadable` when stored data fails its integrity check. `GET /api/files/:id/content` is the same for the 3D viewer (`application/octet-stream`), audited as `file.view`.

## Uploads (resumable, chunked)

* `POST /api/uploads` [case.write, key] `{purpose:"case", caseId (uuid), name, size, arch?: "upper"|"lower"|null, step?: 0..999|null, template?: boolean}` -> `{fileId, chunkSize: 4194304, chunkCount, received: number[], state}`. If arch, step or template are left out for STL, PTS and CSV files they are read from the file name (shared/filenames.ts); send `null` to say "none". The same case + name + size resumes and returns `received` (already complete files return all indexes and their state). 403 `org_not_approved`, 404 unknown case, 409 `case_not_open` (only draft or on_hold), 413 `file_too_large` (512 MB), 415 `file_type_not_allowed` (allowed: stl pts pdf csv svg txt xml json jpg jpeg png; executables always refused), 409 `too_many_files` (600 per case), 400 `empty_file`. Only `purpose: "case"` exists in this phase.
* `PUT /api/uploads/:fileId/chunks/:idx` body `application/octet-stream`, header `x-chunk-sha256` (hex, required). Chunk sizes must be exactly the `chunkSize` returned for the file (4 MB; 8 MB for files started before 9 Oct 2026) except the last (422 `invalid_chunk_size`). 422 `checksum_mismatch`. 415 `file_type_not_allowed` and the upload is removed when the first chunk starts with executable magic bytes (MZ, ELF, Mach-O, `#!`). 409 `upload_closed`. Returns `{received: <number of chunks stored>}`. Sending a chunk again replaces it.
* `POST /api/uploads/:fileId/complete` [case.write, key] -> `{state:"processing"}` (queues `file.process`). 409 `upload_incomplete` with `missing: number[]`. Calling it again is harmless.
* `GET /api/files/:id` [case.read, key] returns File (poll until `state` is `ready` or `rejected`).
* `PATCH /api/files/:id` [case.write, key] `{arch?, step?, template?}` fix mapping while draft/on_hold; recomputes checks. Returns File.
* `DELETE /api/files/:id` [case.write, key] draft/on_hold only. Returns `{ok:true}`.

## Direct manufacturing bulk intake (zip)

* `POST /api/bulk/batches` [case.write, key] `{cases: [{key, patientId?, firstName, lastName, instructions?}] (1 to 500), brandId?, priority?, submitWhenClean?: boolean}` creates one draft `direct` case per entry. Server rules: `patientId` is optional and no longer asked for by the web app (when sent it follows the case ID rules and is stored as the case ID; without it `case_id` is null), first and last name mandatory and at most 50 characters, instructions at most 8,000. A patient ID can be used for more than one direct case (the unique case ID rule covers standard cases only). Names are field encrypted (first, last and combined) with a blind index for both name orders. Returns 201 `{batchId, cases: [{key, id?, ref?, caseId?, error?, message?}]}`; partial success is normal. `error` is one of `invalid_patient_id, first_name_required, last_name_required, name_too_long, instructions_too_long`. When nothing was created the status is 200 and `batchId` is `null`. `submitWhenClean` is stored on the batch for the client and has no server side effect (the client uploads files and then submits each clean case).
* `GET /api/bulk/batches/:id` [case.read, key] -> `{batch: {id, status: open|submitted|completed|failed, caseCount, submitWhenClean, priority, createdAt}, cases: Case[]}` including portal push status. Batch status follows its not cancelled cases (`submitted` when all are submitted, `completed` when all are pushed, `failed` when any push failed).
* `POST /api/cases/:id/portal/retry` [case.write, key] re-queues a failed `bulk.push`. 409 `not_direct`, 409 `not_failed`. Returns `{ok:true, portal:{status:"pending"}}`.
* `GET /api/org/portal-api` [integration.manage] returns `{configured, baseUrl, userUuid, doctorId, defaultGender}` (never the key).
* `PUT /api/org/portal-api` [integration.manage, step up] `{baseUrl, apiKey?, userUuid, doctorId?, defaultGender?}`: the key is optional when one is already stored (400 `api_key_required` otherwise). `baseUrl` must be https, not an IP literal in a private range or an internal host name (400 `invalid_portal_url`); a trailing `/` or `/api/v2` is removed. The key is stored field encrypted with AAD `org|<orgId>|portal_api_key`. Returns the same shape as GET.
* `POST /api/org/portal-api/test` [integration.manage] calls `GET /ping`; returns `{ok:true}` or `{ok:false, code, message}` (generic text, never the portal's own message).
* Each direct case, when submitted, pushes to the K Line portal (BRIEF section 12): `POST /cases` (first and last name, `gender` 2 or the org's `defaultGender`, `product_type` 0, `doctor_instructions`), then PDFs and images one by one to `field_case_other_docs`, then everything else (STL, PTS, CSV, SVG, txt, xml, json) in ONE zip `<ref>-files.zip` (canonical names plus `manifest.csv`) to `field_case_other_docs`, then `PATCH /cases/{uuid}/submit`. Worker job `bulk.push` (5 attempts, exponential backoff from 30 seconds, resumable: the portal case uuid and every finished upload are stored). `portal.status` goes `pending` -> `pushing` -> `pushed`, or `failed` (permanent errors such as 4xx fail at once, temporary ones after the last attempt). Events `portal_pushed` and `portal_push_failed`. `portal.lastError` is fixed text ("The K Line portal rejected the request. (HTTP 422)"), never portal or patient text. Organisations without credentials use the in memory fake client only when `DEMO_MODE` is on (development); otherwise the push fails with "The K Line portal connection is not set up."

## Audit actions added in this phase (visible to the case's organisation)

`case.created case.updated case.submitted case.resubmitted case.cancelled case.deleted case.name_revealed case.package_downloaded case.instructions_updated case.portal_pushed case.portal_push_failed case.portal_retry file.uploaded file.deleted file.download file.view file.infected bulk.batch_created org.portal_api_updated org.portal_api_tested`. No patient names, file names or instruction text in any entry.

## Web app contract

* Routes: `/login`, `/mfa`, `/mfa-setup`, `/portal` (overview), `/portal/send`, `/portal/send/bulk`, `/portal/cases`, `/portal/cases/:id`, `/portal/team`, `/portal/account`, `/portal/access-log`, `/portal/settings/portal-api`, `/console` (K Line overview placeholder), `/privacy`.
* The upload engine works client side: read dropped folders (webkitGetAsEntry) or a zip with `fflate` (streaming `Unzip` so 1 GB zips do not have to be loaded whole), build `InputFile[]` for `shared/filenames.ts` and `shared/bulk.ts`, upload each file entry by entry with 4 files in parallel per case and 2 cases in parallel, sha-256 per chunk (SubtleCrypto), wait for checks (poll `GET /api/files/:id`, or the case detail), then submit clean cases. Chunk requests are exempt from the normal rate limit (6,000 per minute).
