# International transfers: gate, SCC outline and transfer impact assessment outlines

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It explains what the software enforces and gives outlines that Legal must complete. It contains no statement about the current law of Egypt, Mexico or the United States: those points are marked [Legal to research and confirm]. Adequacy decisions and other legal positions change, so do not rely on the lists in this document or in the code without checking them.

## 1. Where transfers happen

The Hub runs in Germany. Patient data leaves the EEA when a case is routed to a production site outside the EEA and the factory system there downloads the files. The demo configuration has five sites:

| Site code | Place | Country | `eea` flag | `adequacy` flag |
|---|---|---|---|---|
| PT-CHV | Chaves | Portugal | yes | no |
| EG-CFZ | Cairo | Egypt | no | no |
| MX-TIJ | Tijuana | Mexico | no | no |
| US-WPB | West Palm Beach | United States | no | no |
| US-MEM | Memphis | United States | no | no |

[K Line to confirm the real site list and the legal entity at each site.]

What leaves the Hub for a site (standard cases, `/api/mes/v1`): 3D models and trim lines, documents, instruction text, bag label text and references. Patient names and the partner's own file names are never sent. Staff at the site can still ask the Hub for a name if their role allows it (see section 5).

Direct manufacturing cases are sent to the K Line customer portal, including the patient's first and last name. The gate picks a site for them as well, but where the customer portal and its production run is outside the Hub's control [confirm].

## 2. The transfer gate as implemented

Source: `shared/geo.ts`, used by `services/cases.ts` (`resolveRouting`), `services/intake.ts` (routing in the console) and `services/partnerReview.ts` (the gates panel).

```
canReceive(partnerCountry, site, sccOnFile):
  partner is in the EEA, or its country is unknown   -> restricted, else return true
  site is in the EEA (site flag or country)          -> true
  site has adequacy (site flag or country)           -> true
  otherwise                                          -> sccOnFile
```

Details:

* **EEA list:** the 27 EU member states plus Iceland, Liechtenstein and Norway.
* **Adequacy list in code:** AD, AR, CA, FO, GG, IL, IM, JP, JE, NZ, KR, CH, GB, UY. The United States is not on it. [Legal to review this list against the European Commission's decisions and their scope. Some decisions cover only certain kinds of organisation. The list must be maintained by hand.] The list in `shared/geo.ts` is only a **default**. The per site `adequacy` flag in the `sites` table (editable in the console by `admin.sites`, audited) is what an administrator relies on: a site with the flag set passes the gate whatever its country. A country on the static list passes without the flag; to withdraw a decision for such a country, Legal must have the list in the code changed. **The United States needs SCCs, or a Data Privacy Framework decision that Legal records by setting the `adequacy` flag of the site** (with the evidence kept in the transfer impact assessment, section 4.3).
* **Site flags.** Each site has `eea` and `adequacy` flags (shown as `inEea` and `hasAdequacy`). They default from the country when the site is created and K Line administrators (`admin.sites`) can change them. A site with `adequacy = true` passes the gate for every EEA partner. Changing a flag is audited as `site.updated`.
* **SCC on file:** an agreement of type `scc` for the partner that is not withdrawn, has a signature date and has not expired (`valid_until` empty or today or later). K Line staff record it in the console (Partners, agreements; needs step up).
* **Partners outside the EEA** are not restricted by this gate. [Legal to decide whether other rules apply to them, for example the UK or a local law.]
* **When it is checked:** when a partner submits a standard case (`403 transfer_blocked` if no allowed site exists, which also stops a submit), when K Line routes or re-routes a case (`transfer_blocked`), **when the factory system pulls cases** (`GET /api/mes/v1/intake`), **when it downloads a file** (`GET /api/mes/v1/files/:id`, `403 transfer_blocked`) and **once a day** in the retention job (`transfer.recheck`). The console lists each site with `allowed` and a reason.
* **What a re-check does:** a standard case that is `ready` or `received` at a site that is no longer legal for the partner (an SCC was withdrawn or has expired, or the site flags changed) goes `on_hold` with the fixed reason "Transfer to this site is no longer covered. K Line will contact you.". The case event, the audit entry `case.transfer_blocked` (visible to the partner), the partner notice and the K Line intake notice carry references only. The case is not listed in the feed and no file is served. A case that is already in production stops serving files but keeps its status. K Line releases the held case after it has fixed the cause (record the SCC again or choose another site).
* **What counts as an SCC:** an agreement of type `scc` that is not withdrawn, has a signature date and whose `valid_until` is empty or not in the past (the last day of validity still counts). An expired agreement counts as not recorded. One function (`services/transferCheck.ts`) is used everywhere.
* **Direct manufacturing cases** (`manufacturing_mode = direct`) are produced by the K Line customer portal. The Hub does not route them to a site, so they have no site and the gate is not applied to them at submit, at routing or in the checks above. The code path is documented in `services/transferGate.ts`. Where the portal runs is a question for Legal (section 1).
* **When it is not checked:** a partner with no site configured gets `409 no_site_configured` when it submits, unless manual review is on, in which case the case waits for K Line.
* **Activation:** a partner with a site outside the EEA and without SCCs can still be activated. The gates panel shows `sccRequired` and `sccMissing` as information, not as a blocker.

What the gate does not do: it does not look at where staff work, where the factory system is hosted, or which legal entity runs the site. Those are organisational questions.

## 3. SCC outline (for Legal to complete)

Standard Contractual Clauses (Commission Implementing Decision (EU) 2021/914) for transfers from K Line Europe GmbH (processor in Germany) to a production site entity outside the EEA.

| Item | Proposed content |
|---|---|
| Parties | Exporter: K Line Europe GmbH (processor). Importer: [entity at the site]. Where the importer is a group company acting as sub-processor, use Module 3 (processor to processor). Where a partner contracts directly with a non EEA processor, Module 2 applies. [Legal to choose.] |
| Docking clause, clause 7 | Optional. [Decide.] |
| Clause 9 sub-processors | Option for general or specific authorisation, and the notice period. [Decide. Must match the DPA with partners.] |
| Clause 11 redress | Optional independent dispute body. [Decide.] |
| Clause 13 supervisory authority | The authority of the controller's member state, or the authority competent for K Line Europe GmbH. [Legal to confirm.] |
| Clause 17 governing law | Law of a member state that allows third party beneficiary rights, for example German law. [Legal to choose.] |
| Clause 18 forum | Courts of that member state. |
| Annex I.A parties | Names, addresses, contacts, roles. |
| Annex I.B description | Categories of data subjects (patients), categories of data (name optional, dental models and trim lines, treatment step data, instructions), special category data (health) with safeguards (encryption, no names in the feed, role based access), frequency (continuous), nature and purpose (manufacturing), retention (see `RETENTION.md`). |
| Annex I.C competent authority | [Legal to fill in.] |
| Annex II TOMs | `TOMs.md` plus the importer's own measures at the site. |
| Annex III sub-processors | `SUBPROCESSORS.md` plus any provider used by the importer. |
| Recording in the Hub | Add the agreement in the console: Partners, the partner, agreements, type `scc`, signature date, expiry, reference. The gate then passes for that partner. One record is per partner, not per site. |

Practical note: the gate treats an SCC record as valid for all non EEA sites of that partner. If the SCCs cover only some sites or entities, give the partner only the matching sites (Partners, sites) so the gate cannot route elsewhere.

## 4. Transfer impact assessment (TIA) outlines

A TIA is required by clause 14 of the SCCs: the parties assess whether the laws and practices of the destination country, including rules on access by public authorities, prevent the importer from meeting its obligations, and what supplementary measures are needed. Complete one for each country. The outline is the same each time.

**Common questions**

1. Description of the transfer: who exports, who imports, what data (section 1), how often, where it is stored at the site, who has access, onward transfers.
2. Local law: data protection law (if any), laws on access by courts, police, intelligence and tax authorities, and how they apply to the importer's kind of business. [Legal to research and confirm. Use local counsel where needed.]
3. Practice: known requests for data, the importer's own experience, the legal remedies available to data subjects.
4. Importer's commitments: notify the exporter of requests, challenge disproportionate ones, disclose the minimum, keep a record.
5. Supplementary measures (technical, contractual, organisational).
6. Conclusion and review date.

**Supplementary measures the software already provides**

* No patient names and no partner file names in the factory feed. The site sees models, trim lines and instruction text.
* Files are encrypted at rest in Germany and delivered over TLS only for cases that are `ready` and routed to that site, and only while the case is `ready`, `received` or `in_production` (`GET /api/mes/v1/files/:id`). Each download is logged to the partner.
* A factory system key is scoped, expires, can be limited to IP ranges and is revocable in the console.
* Production staff users are tied to sites and cannot see other sites' cases.
* Factory systems must verify the SHA-256 and should not keep files longer than needed [contract term to add].
* Hold and cancel stop further downloads: the file disappears from the feed.

**Gaps to weigh in every TIA**

* Instruction text is passed on as written and may contain names.
* The site's staff may hold `case.reveal_name` (role `kl_production`) and bag print files can contain names if the partner's layout asks for it. Decide whether to restrict this for non EEA sites.
* The Hub cannot control what the factory system does with files after download: retention, backups, local copies, remote support access.

### 4.1 Egypt (site EG-CFZ)

| Topic | Notes |
|---|---|
| Data flow | Models, trim lines, instructions and references for cases routed to Cairo. No names. |
| Legal position | [Legal to research and confirm: data protection law and its enforcement, access powers of public authorities, local counsel opinion.] |
| Importer | [Entity name, address, contact] |
| Safeguards | SCCs on file for each EEA partner whose cases may go there; measures in section 4 |
| Decision | [Transfers allowed / allowed with measures / not allowed] Date [ ] Next review [ ] |

### 4.2 Mexico (site MX-TIJ)

| Topic | Notes |
|---|---|
| Data flow | As above, for Tijuana. The site is near a border, which may matter for logistics and for staff locations. |
| Legal position | [Legal to research and confirm: federal data protection law, authorities' access powers, local counsel opinion.] |
| Importer | [Entity name, address, contact] |
| Safeguards | SCCs; measures in section 4 |
| Decision | [ ] Date [ ] Next review [ ] |

### 4.3 United States (sites US-WPB and US-MEM)

| Topic | Notes |
|---|---|
| Data flow | As above, for West Palm Beach and Memphis. |
| Legal position | [Legal to assess: whether the importer is certified under the EU-US Data Privacy Framework (if yes, consider setting the `adequacy` flag for the site and record the evidence; if no, SCCs and a TIA are needed), federal and state laws on government access, the status of the framework at the date of assessment.] |
| Importer | [Entity name, address, contact] |
| Safeguards | SCCs or framework certification; measures in section 4 |
| Decision | [ ] Date [ ] Next review [ ] |

The code treats the United States as a country without adequacy, so US sites need an SCC record for every EEA partner unless an administrator sets the site's `adequacy` flag. Setting that flag is a legal decision, not a technical one, and it is audited.

## 5. Checklist before a non EEA site receives a real case

1. Importer entity and contract known and recorded.
2. SCCs (or another valid tool) signed and recorded for each EEA partner whose cases may go there.
3. TIA done for the country, with a decision and a review date.
4. Partner's DPA lists the site country and entity as a sub-processor location, or the partner has agreed in another way.
5. Decision on names: production role permission, bag files, instructions.
6. Site user accounts created with the production role and the right site.
7. Service key for the factory system created with only the scopes it needs, an expiry and an IP allow list.
8. Transfer gate tested with a real partner record in a test environment.
