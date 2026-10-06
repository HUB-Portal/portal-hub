# Sub-processors and recipients

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It lists the providers the Portal Hub relies on, as far as the repository shows, and what must be confirmed before it is shared with partners. [Square brackets] mark items K Line must fill in or confirm.

The brief fixes the hosting decision: hosting in Germany with Hetzner, and no third party requests from the browser. The software sends patient data to no other company. The list below is therefore short. K Line must check it against its real contracts.

## 1. List (proposed)

| # | Sub-processor | Service | Data it can reach | Location | Safeguards to confirm |
|---|---|---|---|---|---|
| 1 | Hetzner [legal entity name to confirm] | Cloud server for the API, worker, Caddy, PostgreSQL and ClamAV, a cloud volume, and optionally Object Storage (S3 compatible) | Encrypted files and fields (ciphertext), database contents including plain metadata (emails, case references, patient IDs of direct cases, free text), backups on the same host | Falkenstein or Nuremberg, Germany (as the guide chooses) [confirm the real location] | DPA (AVV) signed [ ]. Security certificates and audit reports obtained [ ]. No transfer outside the EU [confirm]. Disk encryption [ ] |
| 2 | Hetzner Storage Box (or equivalent backup storage) [confirm product] | Backups of the database and of storage | Database dumps encrypted with `age` for an offline key (the private key is not on the server or the box); optionally the encrypted file store | Same location as the server (as the guide chooses) [confirm] | Covered by the Hetzner DPA [ ]. Backup key custody [ ]. Restore test [ ] |
| 3 | SMTP provider [name to fill in] | Sends invitation, password reset, registration and notice emails | Recipient email addresses, subjects, fixed text and links. No patient data by design | [EU location to confirm] | DPA [ ]. TLS to the provider [ ]. Sender domain records (SPF, DKIM, DMARC) [ ] |

Caddy gets its TLS certificate from Let's Encrypt. That service sees the domain name and the contact address for expiry warnings, not case data. No other company processes patient data for the Hub. In particular the following are **not** used: analytics, advertising, tag managers, content delivery networks, external fonts or scripts, error tracking services, or cloud malware scanners. The malware scanner (ClamAV) runs on K Line's own server. Its signature update service contacts the ClamAV mirrors but receives no case data.

## 2. Group companies and connected systems (recipients)

These are not sub-processors of the software itself, but receive data from it. K Line must decide whether each is a group company acting under its own instructions, or a sub-processor needing its own contract.

| System | Data received | Where | To confirm |
|---|---|---|---|
| Factory systems (MES) at production sites: PT-CHV (Chaves, Portugal), EG-CFZ (Cairo, Egypt), MX-TIJ (Tijuana, Mexico), US-WPB (West Palm Beach, USA), US-MEM (Memphis, USA) in the demo configuration | Models, trim lines, documents, instructions, bag text, references. No patient names, no partner file names | Site country | Operating legal entity for each site, contract (intra-group data processing agreement or sub-processing agreement), hosting of each factory system, SCCs for non EEA sites. See `TRANSFERS.md` |
| K Line customer portal (API v2.6), used for direct manufacturing | Patient first and last name, instructions, all files of direct cases | [confirm] | Operator, hosting provider and location, contract, retention in the portal (the Hub's purge does not reach it), access controls |
| Partner webhook endpoints and ERP systems | References and counts | Chosen by the partner | The partner's own responsibility |

## 3. Possible additions

* **Google sign in for K Line staff** is in the code but switched off unless the `OIDC_*` settings are filled in. If K Line switches it on, Google (Workspace) processes staff sign in data: the staff member's Google account, email address and the sign in event, and the Hub sends Google the client id, a state, a nonce and a PKCE challenge. Google receives no patient data. Treat Google as a provider for staff authentication: update this list and the record of processing when it goes live, and check the Workspace terms and transfer safeguards.
* A monitoring, log shipping or status page service would be a new sub-processor if logs leave the server. Logs can contain IP addresses and request paths (tokens are hidden). Decide before adding one.

## 4. What must be confirmed before go live

1. Signed processing agreements with Hetzner and with the SMTP provider, and evidence of their security measures.
2. The exact location of the servers and the backup storage.
3. The real list of production sites, the entity that runs each one, and the contract between K Line Europe GmbH and each entity.
4. Operator, hosting and contract for the K Line customer portal and for every factory system.
5. How partners are told about sub-processors and changes (the DPA should say how objections work) [Legal to draft]. The Hub has no subscription or notification feature for this today.
6. Whether any staff or contractor outside the EEA can reach production data or the admin console (remote access counts as a transfer).

Review this list at every change of provider and at least once a year.
