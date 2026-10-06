# Technical and organisational measures (TOMs)

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law or standard. It is written in the style of Annex II of the EU Standard Contractual Clauses and of a data processing agreement (art. 28 and art. 32 GDPR). It describes what the software does on 30 Sep 2026. [Square brackets] mark statements that K Line must confirm.

Processor: K Line Europe GmbH. Controllers: the partner companies. Service: the Portal Hub.

Status column:

* **In code**: implemented in the software and covered by tests unless stated.
* **Configuration**: the software supports it, and the deployment must set it up.
* **Organisational**: a process or agreement that K Line must have. Not provided by the software.
* **Planned**: not in the code yet. Nothing is marked planned at the date above.

## 1. Pseudonymisation and encryption (art. 32(1)(a))

| Measure | Detail | Status |
|---|---|---|
| Per file encryption | AES-256-GCM, random 32 byte key per file, 8 MB chunks with position bound additional data. Tampering, reordering and truncation are detected. | In code (`crypto/envelope.ts`) |
| Field encryption | Patient names, instructions, file names, authenticator secrets, webhook secrets and the portal API key are encrypted with row and column bound additional data. | In code (`crypto/keys.ts`) |
| Key management | Master keys are held outside the database (environment). Keys are identified by key id. `cli rewrap` moves file keys and encrypted fields to the active key in batches, supports a dry run and checks a sample with only the active key. Keyed hashes that cannot be recreated (API keys, recovery codes, CSRF) use a separate stable key id. Key custody, separate backup of the keys and a rehearsal on a copy of production data are organisational tasks. | In code / Organisational |
| Pseudonymous search | Exact patient name search uses an HMAC blind index. The plain name is never searched. | In code |
| Masking | Patient names are masked on screen and revealed only by an explicit, logged action. | In code |
| Canonical file names for production | The factory receives `upper/U01.stl`, never the partner's file name. | In code |
| Encryption in transit | TLS between browser or API client and the Hub, terminated by Caddy with automatic certificates. HSTS with preload. | Configuration (files in `deploy/`) |
| Encryption of storage and backups at host level | The guide puts the database and file store on a LUKS encrypted volume (unlocked by hand after a reboot), or files in a private versioned bucket. Database dumps are encrypted with `age` for an offline key before they leave the server. [Real volume, bucket and key custody to confirm.] | Configuration / Organisational |
| Secret handling | Passwords as scrypt hashes, API keys and recovery codes as keyed hashes, one time tokens as SHA-256. | In code |

## 2. Confidentiality (art. 32(1)(b))

### 2.1 Access control to the application

| Measure | Detail | Status |
|---|---|---|
| Strong authentication | Password plus authenticator app for every user, including administrators. | In code |
| Password rules | At least 12 characters, common passwords refused, no name or email inside. | In code |
| Brute force protection | Lockout from 5 failures (15 minutes, doubling up to 24 hours), rate limits, replay protection, session revoked after five wrong codes. | In code |
| Sessions | Server side, idle timeout 30 minutes, absolute 12 hours, revoked on password change, role change, disabling, authenticator reset and suspension. | In code |
| Step up | A fresh authenticator code for sensitive actions (keys, invitations, specifications, agreements, exports with names). | In code |
| Role based access | Ten roles and 28 permissions enforced on the server. Least privilege by role. | In code (`shared/roles.ts`) |
| Site scope | K Line production staff see and act on cases at their sites only. | In code |
| Joiner, mover, leaver | Administrators invite, change roles, disable and reset users. Disabling ends sessions at once. The last administrator cannot be removed. | In code |
| Single sign on for K Line staff | Optional Google Workspace sign in (OpenID Connect with PKCE, verified ID token, allowed domain, existing staff accounts only). The authenticator code is still required by default. | In code / Configuration |
| Periodic access review | Regular review of who has which role at K Line and at each partner. | Organisational |

### 2.2 Separation of tenants and data

| Measure | Detail | Status |
|---|---|---|
| Logical separation | Application scoping plus PostgreSQL row level security with `FORCE`, restricted database role without bypass, context set per transaction. | In code |
| Separation of duties at database level | The application role cannot alter tables or policies, cannot change or delete audit entries, and has no access to the audit anchor. | In code |
| Partner visibility of K Line access | Partners read every K Line access to their data, including the factory system. | In code |
| API separation | Partner keys, K Line service keys and sessions cannot cross into each other's interfaces. | In code |

### 2.3 Physical and infrastructure security

| Measure | Status |
|---|---|
| Data centre security, power, fire protection, physical access control at the hosting provider (Hetzner, Germany). [Provider certificates and audit reports to be requested and recorded.] | Organisational (provider) |
| Security of K Line offices and of factory sites where case files are processed after download from the Hub. | Organisational |
| Hardening of servers: key only SSH from named addresses, cloud and host firewall, fail2ban, unattended security updates; containers with read only file system, no capabilities, non root users; database and scanner on an internal network with no route out. | Configuration (files and guide in `deploy/`) |

### 2.4 Confidentiality of staff

| Measure | Status |
|---|---|
| Confidentiality undertakings for K Line staff and contractors with access. | Organisational |
| Training on handling patient data, phishing and incident reporting. | Organisational |

## 3. Integrity (art. 32(1)(b))

| Measure | Detail | Status |
|---|---|---|
| Authenticated encryption | GCM detects any change to stored files and fields. The download refuses damaged data (`file_unreadable`). | In code |
| Upload integrity | SHA-256 on every chunk. Content checksums are stored and given to the factory, which must verify them. | In code |
| Malware and content checks | ClamAV scan, content checks, active content blocked, executables refused. | In code |
| Audit log | Append only, hash chained, verified on demand. Every security relevant action is recorded without patient data. | In code |
| Signed production specification | Both sides sign a versioned specification. A SHA-256 of the canonical text is stored and re-checked in the browser. | In code |
| Change control | Migrations are versioned and run by the owner role. Tests run against a real database with the restricted role. | In code |
| Input validation | Schema validation on every route; fixed error text; no echo of input. | In code |
| Independent verification | Penetration test and code review by an independent party. | Organisational (not done yet) |

## 4. Availability and resilience (art. 32(1)(b), (c))

| Measure | Detail | Status |
|---|---|---|
| Job queue with retries | Jobs survive restarts, retry with backoff, and are idempotent where it matters (portal push, webhook delivery, events). | In code |
| Resumable uploads | Chunks resume after interruption. | In code |
| Outbox for webhooks | Events are stored with the business change and retried over about a day. | In code |
| Backups and restore | Nightly `age` encrypted database dumps copied to a Hetzner Storage Box, checked after copy, kept 35 days; optional sync of the encrypted file store; a restore test script that restores into a throw away container and verifies the audit chain. The master keys are kept offline and never in backups. [Schedule, who runs the monthly restore test, and recovery objectives to confirm.] | Configuration / Organisational |
| Redundancy and recovery objectives | [Recovery time and recovery point objectives to define.] Single server deployment unless decided otherwise. | Organisational |
| Monitoring and alerting | Health endpoint `GET /api/health`; logs on stdout. Central monitoring and alerts are not part of the repository. | Configuration |
| Capacity | Rate limits protect the API. Limits are per instance. | In code |

## 5. Regular testing, assessing and evaluating (art. 32(1)(d))

| Measure | Status |
|---|---|
| Automated unit and integration tests run against PostgreSQL (`npm test`). | In code |
| Type checking for server and web (`npm run typecheck`). | In code |
| Independent penetration test before go live and after major changes. | Organisational |
| Dependency and vulnerability scanning, update routine, and ClamAV signature updates. | Organisational / Configuration |
| Breach exercise using `BREACH_RUNBOOK.md`. | Organisational |
| Review of the DPIA, this document and the record of processing at least yearly. | Organisational |

## 6. Organisational measures

| Area | Measure | Status |
|---|---|---|
| Governance | Named system owner, security contact and data protection officer or contact. [Names to fill in.] | Organisational |
| Agreements | A data processing agreement with each partner before uploads unlock. The Hub blocks uploads and submissions until a valid DPA is recorded. Acceptance inside the platform is an open decision. | In code (gate) / Organisational |
| Sub-processors | Authorisation, written agreements and notification of changes. See `SUBPROCESSORS.md`. | Organisational |
| Instructions | K Line processes patient data only on the partner's documented instructions. | Organisational |
| Onboarding control | Self registrations are reviewed by K Line. Activation needs a confirmed email, a DPA and a production site. Sanctions screening is not implemented. | In code / Organisational |
| Data subject requests | Procedure to pass requests from patients to the partner and to support the partner. | Organisational (not defined yet) |
| Breach management | Runbook, roles and templates in `BREACH_RUNBOOK.md`. | Organisational |
| Retention and deletion | Automated purge and scrub (see `RETENTION.md`). Erasure of a case on request by a partner administrator or K Line administrator (step up, audited). A process for return or deletion when a contract ends. | In code / Organisational |
| Transfers | Transfer gate in code, checked at submit, routing, factory pull, factory download and daily; SCCs and transfer impact assessments per country (see `TRANSFERS.md`). | In code / Organisational |
| Privacy by design | No third party requests from the browser, no analytics, names optional and masked, references in notices. | In code |
| Support access | K Line staff support access is role based and logged to the partner. Staff should not ask for patient data by email. | In code / Organisational |
| Change management | Review of changes that touch security, database policies or data flows. | Organisational |
| Business continuity | Plan for loss of the hosting provider, key loss and staff absence. | Organisational |
| Key custody | Who holds the master keys, how they are backed up separately from the data, and who can approve a rotation. | Organisational |
