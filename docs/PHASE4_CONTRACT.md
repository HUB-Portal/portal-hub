# Phase 4 contract: quality claims, production spec, bags, materials

Status: implemented and tested on the server (`server/src/routes/{claims,specs,materials}.ts` plus additions to `cases`, `uploads`, `files`, `bags`; services `claims`, `childCases`, `specs`, `materials`, `requested`; migration 004; `shared/defects.ts`, `shared/spec.ts`). **This file matches the code.** Source: original brief sections 11, 14, 15, 16, 17 (webhook hook only). Phases 1 to 3 are done (BRIEF.md, PHASE2_CONTRACT.md, PHASE3_CONTRACT.md).

Conventions are those of PHASE2/3: JSON under `/api`, session cookie plus `x-csrf-token` on writes, errors `{code, message, ...extra}`, camelCase everywhere the web app sees. Send `{}` as the body of POST requests without data. "Step up" means an authenticator code within the last 10 minutes, else `403 step_up_required`. Routes marked "K Line" answer `403` to partner users and to API keys even when the permission name matches. Row level security applies to every new table; K Line staff run with bypass, audit every K Line access to partner data. Interface text is plain British English without dash separators. No patient data in notifications, job payloads, emails, audit entries, hooks or error text (claim text, messages and material names are typed by people; the UI warns not to type patient names).

## 0. Data model (migration 004, additive)

Migration 001 already had `specs` (old statuses `draft pending signed superseded`, no hash) and the file purposes `claim` and `shipment`. It had no claim or material tables. Migration 004:

* `specs`: statuses become `draft proposed active superseded rejected` (existing rows mapped), new columns `content_hash change_note created_side proposed_by proposed_at partner_signed_name kline_signed_name rejection_note rejected_by rejected_at activated_at updated_at`, unique partial index `specs_one_active_uq (org_id) WHERE status = 'active'`.
* New: `claims`, `claim_items`, `claim_messages`, `materials`, `material_shipments`, `material_shipment_lines`, `material_movements`, `material_alerts` (all with `tenant_isolation` RLS on `org_id`).
* `files`: `claim_id`, `shipment_id`, `cipher_file_id`. `cases`: `requested_items jsonb`, `claim_id`.
* Claim evidence and shipment documents have `case_id = NULL` (so they never count as case files, never enter case checks, packages, the factory feed or bags). Retention purges claim evidence with the claim's case.
* Child cases (replacement, rework) copy each ready file row of the parent (`purpose 'case'`, state `ready`) into the child. The row points at the SAME stored encrypted bytes (`cipher_file_id` = the parent's file id, needed because the ciphertext is bound to that id). Nothing is uploaded or stored again. Retention deletes stored objects only when no live file still points at them, so purging a parent never breaks a child.

## 1. Quality claims (brief section 14)

### Shared code
`shared/defects.ts`: `DEFECT_CODES`, `DEFECTS` (`{code, label}`), `defectLabel`, `isDefectCode`, `CLAIM_STATUSES`, `OPEN_CLAIM_STATUSES`, `CLAIM_RESOLUTIONS`, `CLAIMABLE_CASE_STATUSES`. Codes: `DEBRIS FOIL_RESIDUE WASH_RESIDUE SCRATCHES TRANSPARENCY THERMO_INSUFFICIENT DEFORMED CRACK TRIM_LINE TRIM_DISTAL SHARP_EDGE NOTCH_CUT TEMPLATE_TRIM LASER_MARK WRONG_STEP MISSING PACKAGING OTHER`.

### Shapes
```
Claim {
  id, number ("CLM-2026-00001"), status: open|in_review|awaiting_partner|accepted|rejected|closed,
  resolution: remake|credit|no_action|other|null, summary, description|null, specClauseIds: string[],
  rootCause|null, correctiveAction|null, decisionNote|null,
  caseId, caseRef, caseKind, caseStatus, orgId, orgName, orgCode,
  reworkCaseId|null, reworkCaseRef|null, openedByName|null, itemCount, evidenceCount,
  createdAt, updatedAt, decidedAt|null, closedAt|null
}
ClaimDetail {                      // GET /api/claims/:id, GET /api/console/claims/:id, POST /api/claims (201), POST .../decision (200)
  claim: Claim,
  items: [{id, arch: "upper"|"lower", step, template, defectCode, defectLabel, note|null}],   // in the order the partner listed them
  messages: [{id, side: "partner"|"kline"|"system", authorName|null, body, createdAt}],       // oldest first
  evidence: File[],                // uploaded files with claimId set (see file shape below)
  specClauses: [{id, title|null}]  // the cited clauses, titles from the case's spec
}
```
`messages[].authorName`: `null` for system messages; partners see `"K Line"` for K Line messages (no names of staff), K Line staff see the real name.

### Routes
* `POST /api/claims` [claim.write, partner user, no API key] body `{caseId, summary (3 to 200), description? (max 4,000), specClauseIds?: string[] (max 20), items: [{arch, step, template?, defectCode, note? (max 500)}] (1 to 100)}` returns **201 `ClaimDetail`**. The case must be `received|in_production|shipped|delivered` (`409 case_not_claimable`), not purged (`409 case_purged`); every item's aligner (arch, step, template flag) must be a ready STL of the case (`409 unknown_aligner`); every clause id must exist in the spec attached to the case (`400 unknown_clause`; a case with no spec has none); unknown defect code `400 invalid_request`. Creates status `open`, system message "Claim opened.", case event `claim_opened`, audit `claim.opened`, hook `claim.updated`, and a K Line notification (by job, see section 4). K Line users get `403`, another partner's case `404`. Direct manufacturing cases can have claims as long as their status is claimable.
* `GET /api/claims?status=&caseId=&orgId=&page=&pageSize=` [claim.read, API key scope `claims:read`] returns `{items: Claim[], total, page, pageSize}`, newest first. `status` is any claim status or `active` (= open, in_review, awaiting_partner). Partners see their own; K Line sees all (`orgId` filters). Production staff tied to sites only see claims of cases at their sites.
* `GET /api/claims/:id` [claim.read, key] returns `ClaimDetail`. A K Line user opening a claim writes `claim.viewed` to the partner's audit log (at most once per person and claim in 10 minutes).
* Evidence: `POST /api/uploads` `{purpose: "claim", claimId, name, size}` [claim.write, partner user], then the normal chunk and complete routes. Allowed: `jpg jpeg png mp4 mov m4v pdf`; images and PDFs at most 50 MB, videos at most 512 MB (`413 file_too_large`), at most 40 files per claim (`409 too_many_files`), other types `415 file_type_not_allowed`, executables refused at the first chunk. The claim must be `open|in_review|awaiting_partner` (`409 claim_not_open`). Content is checked by magic bytes (images as before; videos need an MP4/MOV box header; a bad file ends up `state: "rejected"`). `DELETE /api/files/:id` removes own evidence while the claim is open (needs claim.write). Uploading is for people in the partner organisation only (K Line answers in messages). Download uses the existing `GET /api/files/:id/download` and `/content` [file.download]: audited as `file.download` to the partner organisation with `details.claimId`.
* `POST /api/claims/:id/messages {body}` [claim.write] (partner users and K Line staff) body 1 to 4,000 characters, returns **201 `{message: {id, side, authorName, body, createdAt}, status}`** where `status` is the claim status afterwards. A partner message on `awaiting_partner` moves the claim back to `in_review`. The other side is notified. `409 claim_closed` on a closed claim.
* K Line only:
  * `POST /api/claims/:id/status {status: "in_review"|"awaiting_partner"}` [claim.write] returns `{claim: Claim}`. Adds a system message, notifies the partner. `409 claim_decided` after a decision, `409 status_unchanged`.
  * `POST /api/claims/:id/decision {decision: "accepted"|"rejected", resolution?: remake|credit|no_action|other, rootCause? (max 2,000), correctiveAction? (max 2,000), note? (max 2,000)}` [claim.decide] returns `ClaimDetail`. Accepted needs a resolution (`400 resolution_required`), rejected needs a note of at least 3 characters (`400 note_required`). A note is also added to the thread as a K Line message. Only from `open|in_review|awaiting_partner` (`409 claim_decided`). System message and partner notification. `remake` creates the rework case (below) in the same transaction and sets `claim.reworkCaseId`; if that is impossible (`409 files_unavailable`, files purged) nothing changes.
  * `POST /api/claims/:id/close` [claim.decide] returns `{claim}`. Only from accepted or rejected (`409 claim_not_decided`), `409 claim_closed` when already closed.
  * `GET /api/console/claims?status=&orgId=&caseId=&page=&pageSize=` and `GET /api/console/claims/:id` [claim.read, K Line]: same shapes as the shared routes.
* `GET /api/console/overview` `openClaims` is now the number of claims in open, in_review or awaiting_partner (site scoped for production staff).

### Rush rework case (decision `accepted` + `remake`)
Child case with `kind: "rework"`, `parentId` = the claimed case, `priority: "rush"`, `claimId`, `requestedItems` = the claim's items as `[{arch, step, template, defectCode}]` (duplicates by arch, step and template removed), notes = `Rework order for quality claim CLM-...` then the parent's instructions, the parent's patient name and case ID re-encrypted for the child, brand and warning acknowledgement copied, `spec_id` = the active spec (else the parent's). Events: on the child `created` (data `{kind, parentRef, claimNumber}`) and `submitted`; on the parent `rework_ordered` (data `{childRef, items, claimNumber}`). Audit `case.rework_ordered`. Routing is the same as for a new case: with `manual_review` off the child goes straight to `ready` at the organisation's default or first allowed site (hook `case.ready`; it is in the factory feed at once); with `manual_review` on, or when no site may receive it, it stays `submitted` with no site, K Line intake sees it on the review tab (notification `case_submitted` by job) and routes it. A rework of a **direct manufacturing** case is created as a `standard` case so the factory system can make it.

### Replacement orders (brief section 9)
`POST /api/cases/:id/replacement {items: [{arch, step, template?}] (1 to 400), reason? (max 500 after cleaning)}` [case.write, key allowed, partner only] returns **201 `{case: Case}`** (the child). Parent must be `shipped|delivered` (`409 case_not_replaceable`), `standard` mode (`409 direct_case`), not purged (`409 files_unavailable`); organisation approved (`403 org_not_approved`); every aligner must exist (`409 unknown_aligner`). Child: `kind: "replacement"`, `priority: "normal"`, `requestedItems`, notes `Replacement order. Reason: <reason>` then the parent's instructions, routed like a new case (see above), events `created`, `submitted` on the child and `replacement_ordered` (data `{childRef, items}`) on the parent, audit `case.replacement_ordered`.

### Case JSON and factory feed additions
* Case (list and detail, partner and console): `parentId, parentRef, specVersion (number|null), requestedItems ([{arch, step, template, defectCode?}]|null), claimId, claimNumber`. Counts (`upper lower templates`) of a child only count the requested aligners.
* `GET /api/cases/:id` and `GET /api/console/cases/:id` add `children: [{id, ref, kind, status, priority, createdAt}]` and `claims: [{id, number, status, summary, createdAt}]` next to `case files events instructions`.
* File JSON adds `claimId` and `shipmentId` (null for case files).
* MES intake (`GET /api/mes/v1/intake`): `spec_version` is the attached spec version (or null), new `claim_number`, `items` = the requested aligners as `[{aligner: "U02" (or "U01_T" for a template), arch, step, template, defect_code|null}]` (empty for a new case), and every file has `requested: boolean` (false for parent files of aligners not in `items`; files without arch and step, such as documents, are always true). `aligner_counts` and `bags` only cover the requested aligners of a child. Only ready files are listed, `download_url` works as before (the factory reads the child's files through the same route).

## 2. Production spec (brief section 15)

### Shared code (`shared/spec.ts`, used by server and web)
`SPEC_SECTIONS`, `SPEC_SECTION_INFO` (label and prefix per section), `SPEC_LIMITS`, `CLAUSE_ID_RE`, `specContentSchema` (zod, strict), `parseSpecContent(input) -> {ok, content} | {ok: false, problems: string[]}`, `defaultSpecContent()` (fresh copy, short generic K Line defaults, 2 to 3 clauses per section and `bag` = the default bag layout), `clausesOf`, `clauseIds`, `canonicalJson(value)`, `sha256Hex(text)`, `hashSpec(content)` (both async through Web Crypto, so they work in browsers and Node), `diffSpecs(base, target)`.

Content: `{schemaVersion: 1, material, trim, hooks, templates, finish, marking, packaging, records: {clauses: [{id, title, text}]}, bag: BagLayout}`. Clause id `PREFIX-n` with prefix by section: material `MT`, trim `TR`, hooks `HK`, templates `TP`, finish `FN`, marking `MK`, packaging `PK`, records `RC`; n is 1 to 999; ids unique in the whole spec; the prefix **must match the section**. Title 1 to 120, text 1 to 2,000 characters (trimmed, no control characters), at most 40 clauses per section. `bag` follows the `shared/bag.ts` limits and placeholder rules. Unknown keys are refused. Canonical JSON: keys sorted (UTF-16 order) at every level, no whitespace, arrays in order, undefined properties left out, numbers and strings as `JSON.stringify`. Hash = lower case hex SHA-256 of the UTF-8 canonical JSON of `content`. **Test vectors** (also in `server/test/phase4.unit.test.ts`): `{}` -> `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`; `[]` -> `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`; `{"b":1,"a":[true,null,"x"]}` (canonical `{"a":[true,null,"x"],"b":1}`) -> `54a65415ad370228851a1da4b31b6fd42dc58b19a50d35cae759325f7388ce64`; `{clauses:[{title:"Film", text:'Café "film"', id:"MT-1"}]}` -> `be95cd43e13cec28c0ff75be577f7de41699434066469d993953fc16b4f098df`.

`diffSpecs(base, target) -> {sections: [{section, label, added: Clause[], removed: Clause[], changed: [{id, before:{title,text}, after:{title,text}, titleChanged, textChanged}]}] (all eight sections, in order), bag: {changed, before, after}, changeCount}`. `added` = in target and not in base.

### Shape
```
Spec {                 // list rows leave out `content`
  id, orgId, orgName, version, status: draft|proposed|active|superseded|rejected, title, changeNote|null,
  contentHash, createdSide: "partner"|"kline", proposedAt|null,
  partnerSignature: {name, signedAt}|null, klineSignature: {name, signedAt}|null,
  rejectionNote|null, rejectedAt|null, activatedAt|null, createdAt, updatedAt,
  actions: {edit, delete, propose, sign, reject}   // what THIS caller may do right now
  content: SpecContent
}
```
Drafts are private to the side that started them: the other side gets `404` for a draft and does not see it in lists. Everything from `proposed` on is visible to both sides. Version numbers are per organisation; a deleted draft can leave a gap.

### Routes
All spec routes exist under `/api/specs` and, for K Line staff, under `/api/console/specs` with the same behaviour (the console prefix answers `403` to partners). K Line users must give the partner: `?orgId=` on lists and `orgId` in the body of `POST`; missing means `400 org_required`, an unknown or non partner organisation `404`. Partners: `orgId` is ignored.
* `GET /api/specs?orgId=` [spec.read] returns `{items: Spec[] (newest version first, no content), activeId|null}`.
* `GET /api/specs/active?orgId=` [spec.read] returns `{spec: Spec|null}`.
* `GET /api/specs/default` [spec.read] returns `{content, contentHash}` (the default template).
* `GET /api/specs/:id` [spec.read] returns `{spec}` with `content`.
* `GET /api/specs/:id/diff/:otherId` [spec.read] returns `{from: {id, version, status} (= otherId), to: {id, version, status} (= id), ...diffSpecs(other, this)}`. Both must belong to the same organisation.
* `POST /api/specs {orgId?, baseSpecId?, changeNote?, title?}` [spec.edit; K Line: spec.edit, claim.decide or admin.partners] returns **201 `{spec}`**: a draft copying `baseSpecId`, else the active version, else the default template.
* `PUT /api/specs/:id {content, changeNote?, title?}` same rights, own side's draft only (`409 spec_not_draft`, `403` for the other side's), validated (`400 invalid_spec` with `problems: string[]`), returns `{spec}` with the recomputed hash.
* `DELETE /api/specs/:id` same rights, draft only, returns `{ok: true}`.
* `POST /api/specs/:id/propose` same rights, **step up**, own side's draft: draft -> proposed, revalidates, stores hash, notifies the other side. The proposing side has NOT signed until it calls sign.
* `POST /api/specs/:id/sign {contentHash?}` [spec.sign, **step up**] (partner users with spec.sign: admin, quality; K Line: kl_admin, kl_quality) signs for the caller's side (name, time, user). If `contentHash` is sent it must equal the stored hash (`409 hash_mismatch`; the stored text is also re-hashed). `409 spec_not_proposed`, `409 already_signed` (that side has signed, by anyone), `409 same_signer` (defensive). When both sides have signed in the same transaction: previous active -> `superseded`, this one -> `active` (`activatedAt`), the organisation's `settings.bag` becomes the spec's `bag`, both sides are notified. The unique index guarantees one active version.
* `POST /api/specs/:id/reject {note}` [spec.sign, **step up**] note 3 to 1,000 characters (`400 note_required`), proposed only, status `rejected`, the other side notified.
* `GET /api/console/specs/partners` [spec.read, K Line] returns `{items: [{orgId, name, code, orgStatus, activeSpecId|null, activeVersion|null, activatedAt|null, proposed: {id, version, needsKlineSignature, needsPartnerSignature}|null, klineDrafts}]}` for every partner.
* Every response of the write routes is `{spec}` with `content`.

### Cases, claims and bags
* `submitCase` attaches the active version (`cases.spec_id`, `specVersion` in Case JSON, `spec_version` in the factory feed). It is set at every submit (also a resubmit from hold). Cases made before any spec have `specVersion: null`. Child cases attach the version that is active when they are created.
* Bag layout authority: while a spec is active `PUT /api/org/bag-layout` is refused with `409 bag_in_spec`; the bag lives in the next spec draft. `GET /api/org/bag-layout` gains `lockedBySpec: boolean` and `specVersion: number|null` and returns the active spec's layout. The factory feed and the bag CSV use the active spec's bag (then the saved organisation layout, then the default).

## 3. Partner supplied materials (brief section 16)

### Shapes
```
Material { id, orgId, orgName?, sku, name, category: box|bag|elastic|button|insert|other, unit, perCase, perAligner, minStock, active, createdAt,
           stock: [{siteCode, siteName, onHand, inTransit, used28d, daysOfCover|null, lowStock}] }
Shipment { id, number ("SHP-2026-00001"), orgId, orgName, orgCode, siteCode, siteName, carrier|null, tracking|null, expectedDate ("YYYY-MM-DD")|null,
           status: in_transit|received|discrepancy|cancelled, receivedAt|null, receiveNote|null, createdAt,
           lines: [{id, materialId, sku, name, unit, quantity, receivedQuantity|null, difference|null}] }
```
Stock rows exist for the organisation's default site and every site that held or was sent the material. `onHand` = sum of movements (receipts, adjustments, negative consumption), can go below zero; `inTransit` = quantities of shipments still `in_transit` to that site; `used28d` = consumption in the last 28 days (positive number); `daysOfCover = onHand / (used28d / 28)`, one decimal, `null` when nothing was used, `0` when on hand is not positive; `lowStock` = `minStock > 0 && onHand < minStock`.

### Routes
* `GET /api/materials` [material.read, key scope `materials:read`] returns `{items: Material[]}` (own organisation; inactive ones included with `active: false`).
* `POST /api/materials` [material.manage, partner only] body `{sku (1 to 60), name (1 to 120), category, unit? (default "pieces"), perCase? (0 to 1,000,000, default 0), perAligner?, minStock?}` returns **201 `{material}`**. SKU unique per organisation, case insensitive (`409 sku_exists`).
* `PATCH /api/materials/:id` [material.manage, partner only] any of the same fields plus `active`, returns `{material}`.
* `GET /api/material-shipments?status=&siteCode=&page=&pageSize=` [material.read, key] returns `{items: Shipment[], total, page, pageSize}` (in transit first, then newest). `GET /api/material-shipments/:id` returns `{shipment, documents: File[]}`.
* `POST /api/material-shipments` [material.declare, partner users, organisation approved else `403 org_not_approved`] body `{siteCode, carrier?, tracking?, expectedDate? ("YYYY-MM-DD"), lines: [{materialId, quantity (whole number 1 to 1,000,000)}] (1 to 50, one line per material, `400 duplicate_line`)}` returns **201 `{shipment}`** (status `in_transit`). `400 invalid_site` when the site is not one of the organisation's active sites, `400 invalid_material`.
* `POST /api/material-shipments/:id/cancel` [material.declare, partner] in transit only (`409 shipment_not_in_transit`), returns `{shipment}`.
* Documents: `POST /api/uploads {purpose: "shipment", shipmentId, name, size}` [material.declare, partner], `pdf jpg jpeg png`, at most 25 MB each and 20 files, only while the shipment is `in_transit` (`409 shipment_not_open`). `DELETE /api/files/:id` removes one (same rights and state). K Line downloads with `GET /api/files/:id/download` (audited to the partner with `details.shipmentId`).
* K Line [material.read, K Line]: `GET /api/console/materials?orgId=` returns `{items: Material[]}` (all partners when `orgId` is left out, each with `orgName`), `GET /api/console/material-shipments?status=&siteCode=&orgId=&page=&pageSize=` and `GET /api/console/material-shipments/:id` (same shapes as above). Production staff tied to sites only see shipments for their sites (`404` otherwise).
* `POST /api/console/material-shipments/:id/receive {lines: [{lineId, receivedQuantity (whole number 0 and up)}], note? (max 1,000)}` [material.receive, K Line, site scope] returns `{shipment}`. Every line must be answered (`400 lines_mismatch`). Status becomes `received`, or `discrepancy` when any quantity differs from the declared one. Receipts above zero become `receipt` movements at the shipment's site. `409 shipment_not_in_transit` when it was already dealt with. The partner is notified.
* `POST /api/console/materials/adjust {orgId, materialId, siteCode, quantity (signed whole number, not 0), reason (3 to 300)}` [material.receive, K Line, site scope] returns `{material}` (with fresh stock). `adjustment` movement, audited `material.adjusted` with the reason (visible to the partner). Low stock check follows.

### Consumption and low stock
* When the stage engine ships a case (stage `shipped`, or `delivered` for a case that never shipped through the system; any source: factory events, CSV, manual) it books, once per case and material (unique index), a `consumption` movement of `-(perCase + perAligner x aligners shipped)` for every active material with a rule, at the case's site (else the organisation's default site). Audit `material.consumed` (actor system). Replacement and rework cases consume like any case.
* Low stock: after a consumption or adjustment, if a material with `minStock > 0` has `onHand < minStock` at that site and no notice was sent for that material and site in the last 24 hours (`material_alerts`), the partner gets an in app notification (kind `material_low_stock`, whole organisation, body `<material name> at <site name>: <n> left`), an email (fixed text, template `notice`, to every active user with the `material.manage` permission who has email notices on) and the hook `materials.low_stock`.
* Partners never see other partners' stock (RLS); K Line sees all.

## 4. Notifications, hooks, audit

* **K Line notifications from partner requests are written by a worker job** (`notify.push`, run under the system role), because partner requests run with row level security limited to their own organisation and can neither read nor write K Line rows. Tests and the web app must not expect them before the worker has run (in development it runs inside the API within about two seconds). Notifications to the partner are written at once. Kinds: to K Line `claim_opened claim_message spec_proposed spec_signed spec_activated spec_rejected material_shipment case_submitted`; to the partner `claim_status claim_message claim_decision claim_closed spec_proposed spec_signed spec_activated spec_rejected material_received material_low_stock`. All are addressed to the whole organisation (no user), title fixed text, body by reference only (`Claim CLM-2026-00001, case ACME-000001`, `Shipment SHP-2026-00001, site PT-CHV`, `<org>, version 3`), `data` holds ids and references.
* Hooks in `services/webhooks.ts` (still no ops; `setHookObserver` lets tests see them): `emitClaimWebhook(claim.updated)`, `emitSpecWebhook(spec.updated)`, `emitMaterialsWebhook(materials.low_stock)`, and the existing `emitCaseWebhook(case.ready)` for child cases that are routed at once.
* Audit actions (in the partner's log; K Line staff appear as "K Line staff" without names): `claim.opened claim.message claim.status_changed claim.accepted claim.rejected claim.closed claim.viewed spec.draft_created spec.draft_updated spec.draft_deleted spec.proposed spec.signed spec.rejected spec.activated spec.superseded material.created material.updated material.shipment_declared material.shipment_cancelled material.shipment_received material.adjusted material.consumed case.rework_ordered case.replacement_ordered file.uploaded file.deleted file.download file.infected` (the last four also for claim evidence and shipment documents, with `details.claimId` or `details.shipmentId`).

## 5. Route table

| Method and path | Permission | Step up | Notes |
|---|---|---|---|
| POST /api/claims | claim.write | no | partner users only |
| GET /api/claims, GET /api/claims/:id | claim.read | no | keys with `claims:read` |
| POST /api/claims/:id/messages | claim.write | no | both sides |
| POST /api/claims/:id/status | claim.write | no | K Line only |
| POST /api/claims/:id/decision | claim.decide | no | K Line only |
| POST /api/claims/:id/close | claim.decide | no | K Line only |
| GET /api/console/claims, GET /api/console/claims/:id | claim.read | no | K Line only |
| POST /api/cases/:id/replacement | case.write | no | partner, keys allowed |
| GET /api/specs, /active, /default, /:id, /:id/diff/:otherId | spec.read | no | also under /api/console/specs |
| POST /api/specs, PUT /api/specs/:id, DELETE /api/specs/:id | spec.edit (K Line also claim.decide or admin.partners) | no | own side's drafts |
| POST /api/specs/:id/propose | same as above | yes | |
| POST /api/specs/:id/sign, POST /api/specs/:id/reject | spec.sign | yes | |
| GET /api/console/specs/partners | spec.read | no | K Line only |
| GET /api/materials | material.read | no | keys with `materials:read` |
| POST /api/materials, PATCH /api/materials/:id | material.manage | no | partner only |
| GET /api/material-shipments, /:id | material.read | no | keys with `materials:read` |
| POST /api/material-shipments, POST .../:id/cancel | material.declare | no | partner only; declare needs an approved organisation |
| POST /api/uploads (purpose claim) | claim.write | no | partner users only |
| POST /api/uploads (purpose shipment) | material.declare | no | partner users only |
| GET /api/console/materials, /material-shipments, /material-shipments/:id | material.read | no | K Line only |
| POST /api/console/material-shipments/:id/receive | material.receive | no | K Line, site scope |
| POST /api/console/materials/adjust | material.receive | no | K Line, site scope |

## 6. Deviations from the first draft of this contract

1. Claim evidence and shipment documents are files with `case_id = NULL` (not attached to the case), so they never touch case checks, packages or the factory feed.
2. Replacement and rework children use `status: "submitted"` only when the organisation has manual review on or no site may receive them; otherwise they are `ready` at once (same routing as a submitted new case). The draft said "status submitted" and "respect manual_review" together.
3. Child cases copy the parent's file rows and point at the same stored bytes (`cipher_file_id`); retention was extended so shared objects survive until the last user is purged.
4. Rework of a direct manufacturing case is created as a `standard` case; replacement orders for direct cases are refused (`409 direct_case`).
5. Clause ids must use the prefix of their section. Drafts are private to their side. Only one active version per organisation (database index).
6. Extra routes: `GET /api/specs/default`, `GET /api/console/specs/partners`, `GET /api/material-shipments/:id`, `GET /api/console/material-shipments/:id`, `GET /api/console/materials` (all partners without `orgId`), `DELETE /api/files/:id` for evidence and documents. `sign` accepts an optional `contentHash`. Case detail gains `children` and `claims`.
7. K Line notifications caused by partner requests go through the `notify.push` job (see section 4).
8. `POST /api/claims/:id/messages` answers 201 `{message, status}`; a K Line message does not change the claim status.
9. Materials have an `active` flag (PATCH) instead of deletion. Quantities on shipments, receipts and adjustments are whole numbers; usage rules may be fractions.
10. Nothing patient related is encrypted in claim text fields: claim summary, description, item notes, messages and the material names are plain text typed by people (the UI must warn against patient names).

## 7. Web app

Partner: Quality claims list and detail (`/portal/claims`, `/portal/claims/:id`, new claim from a case page action `Report an issue` `/portal/cases/:id/claim`): defect per aligner picker (from the case's aligner manifest, `DEFECTS` labels), photo and video upload with progress and preview, spec clause picker (clauses of `case.specVersion`'s spec via `GET /api/specs/:id`, or the active spec), message thread; case page: Order replacement action (select aligners), child case links (`children`, `parentRef`), claim list on the case (`claims`). Production spec (`/portal/spec`): active version viewer with clause list, drafts and proposals list, history and diff view, clause editor for drafts, propose, sign with fresh authenticator code, reject with note, and the hash check badge (browser recomputes SHA-256 of `canonicalJson(content)` with `hashSpec` from `@shared/spec` and shows match or mismatch with `contentHash`); the bag designer lives inside the spec editor (reuse the phase 3 editor component with live preview) and the old bag layout page shows a notice when `lockedBySpec` is true. Materials (`/portal/materials`): items with usage rules and stock per site table with days of cover and low stock highlight, declare shipment dialog, shipments list with status and receipt results.

K Line console: Quality claims (`/console/claims`, triage: status change, messages, decision dialog with resolution, root cause and corrective action, close, link to rework case), Partner specs (per partner list from `/api/console/specs/partners`, propose and sign for the K Line side, diff), Partner materials (`/console/materials`: shipments to receive with quantity inputs and discrepancy highlight, stock corrections dialog), overview tile for open claims, nav entries by permission.
