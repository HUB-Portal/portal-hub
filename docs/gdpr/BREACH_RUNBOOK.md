# Personal data breach runbook

> **DRAFT for review by K Line's Legal and Compliance.** This document is not legal advice and does not certify compliance with any law. It is an operating procedure for engineers and managers, built on what the Portal Hub can do on 30 Sep 2026. Legal must check the deadlines, the wording of the templates and who decides what. [Square brackets] mark names, times and decisions to fill in.

## 1. The rules in short

* A personal data breach is a breach of security that leads to accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data.
* When K Line acts as **processor** (patient data of partners), it must tell the affected partner (the controller) **without undue delay** after becoming aware (art. 33(2) GDPR). The partner decides about notifying its supervisory authority and patients. [Check the exact duty and time limit in each DPA. Suggested internal target: tell affected partners within 24 hours of confirming a breach.]
* The **controller** must notify the competent supervisory authority **within 72 hours** of becoming aware, unless the breach is unlikely to result in a risk to people (art. 33(1)). If the risk is high, the controller must also tell the people affected without undue delay (art. 34).
* When K Line is **controller** (account, registration and audit data), K Line notifies its own supervisory authority within 72 hours and decides about telling the people affected.
* Keep a record of every breach, including those that are not notified (art. 33(5)).
* When in doubt, treat it as a breach and start the clock.

## 2. Roles

| Role | Person | Does |
|---|---|---|
| Incident lead | [name, deputy] | Runs the incident, keeps the timeline, decides priorities |
| Security engineer on call | [name] | Investigates, contains, collects evidence |
| Data protection officer or privacy contact | [name], [PRIVACY_EMAIL] | Assesses risk, advises on notification, talks to authorities |
| Legal and Compliance | [name] | Checks contracts and deadlines, approves notices |
| Account manager for the partner | [name] | Talks to the affected partner |
| Management | [name] | Decides on major steps such as shutting down |
| Communications | [name] | Approves external statements |

Keep contact details (mobile numbers, backup contacts) somewhere that does not depend on the Hub.

## 3. Steps and timeline

The clock starts when K Line has a reasonable degree of certainty that a breach has happened. Write the time down.

| When | Step |
|---|---|
| T0 | **Detect and report.** Anyone who suspects a breach tells the incident lead at once. Open an incident record with the time, who reported it and what was seen. |
| T0 + 1 hour | **Triage.** Is personal data involved? Which systems, which partners, which data (names, files, accounts)? Is it still going on? Decide the severity. |
| T0 + 4 hours | **Contain.** Stop the harm (section 5). Preserve evidence before changing things (section 4). |
| T0 + 24 hours | **Tell affected partners** (initial notice, section 7.1). More detail may follow. [Target to be confirmed.] |
| T0 + 48 hours | **Assess risk** with the partner: likelihood and severity for patients. Prepare the authority notice for the controller if the partner asks for help. |
| T0 + 72 hours | The controller's deadline to notify the supervisory authority (section 7.2). If K Line is the controller, K Line notifies. A late notice needs reasons. A phased notice is allowed when details are missing. |
| After | **Recover, review and improve.** Close the incident with lessons learned, update the DPIA and this runbook. |

## 4. Evidence to collect (before it is lost)

* **Times and people:** when the event started, when it was noticed, who noticed it.
* **Audit log.** The audit log is append only and hash chained. First prove it is intact:
  * On the production server: `docker compose -f deploy/docker-compose.prod.yml run --rm migrate node dist/cli.js audit-verify`. In development: `cd server && npx tsx src/cli.ts audit-verify`. Exit code 0 and "Audit chain OK" means the chain is intact. Exit code 1 names the first broken entry: that is itself an incident.
  * In the console, `kl_admin` can choose **Verify chain** in **Audit log**.
  * Export the relevant entries. A partner sees its own entries in **Access log** (`GET /api/audit?limit=200&action=<prefix>`). For a cross partner investigation an engineer reads `audit_log` directly as the owner role, after `SELECT set_config('kph.bypass', 'true', false);` (row level security is forced on the table, unless the role is a superuser).
* **Useful action names** (see `audit_log.action`): `auth.login`, `auth.login_failed`, `auth.mfa_failed`, `auth.step_up_failed`, `auth.password_changed`, `auth.password_reset`, `auth.session_revoked`; `case.name_revealed`, `case.names_revealed`, `case.name_searched`, `case.viewed`, `case.package_downloaded`, `case.bags_csv`; `file.download`, `file.view`, `file.infected`; `mes.intake_read`; `export.cases_csv`, `export.shipments_csv`; `api_key.created`, `api_key.revoked`; `service_key.created`, `service_key.revoked`; `webhook.created`, `webhook.updated`, `webhook.secret_rotated`, `webhook.auto_disabled`; `staff.*`, `partner.*`, `org.portal_api_updated`, `site.updated`, `audit.verified`.
  Each entry has the actor type (`user`, `api_key`, `service`, `system`), actor id, organisation, IP address, user agent and time.
* **Sessions and keys:** `sessions` (IP, user agent, created, last seen, revoke reason), `api_keys.last_used_at` and `last_used_ip`, `users.last_login_at`, `webhooks.last_attempt_at`.
* **Application logs** (stdout/stderr of API and worker, proxy logs): request ids (`X-Request-Id`), IP addresses, status codes. Tokens and bodies are not logged by design.
* **Infrastructure:** provider logs, firewall logs, SSH logins, database connection logs, storage access logs, backup job logs.
* **System state:** a disk or volume snapshot of affected servers, list of running processes and configuration, before any clean up.
* **Scope:** which organisations, which cases, how many files and patients, which fields (names, images, instructions), whether data was encrypted (ciphertext only, or plain). Note that files and names are encrypted at rest, so a stolen storage copy without the master keys is ciphertext.
* Keep copies read only, with a hash and a chain of custody note.

## 5. Containment options in the Hub

| Situation | Action |
|---|---|
| A user account is compromised | Disable the user (Team or Staff): their sessions end at once. Reset the authenticator. Force a new password (password reset). Check recent entries for that actor. |
| A session or device is unknown | The person can sign out other devices in **Account**. An administrator disabling the user revokes every session. |
| A partner API key leaked | Revoke it in **ERP and API, API keys** (step up). This needs `integration.manage`, which no partner role holds at the moment, so there is no screen for it until that is decided. A revoked key stops working at once. Check `case.names_revealed` and file reads by that key. |
| A K Line service key leaked | Revoke it in **Service keys**. Create a new one with an IP allow list. |
| A webhook secret leaked | Rotate the secret (step up, needs `integration.manage`, same note as above). Switch the webhook off if the endpoint is suspect. |
| A whole partner is compromised or abusive | Suspend the partner in **Partners**: sessions end and keys stop working. |
| Registration abuse | Set `SIGNUP_ENABLED=false` and restart. Decline and delete suspicious registrations. |
| A malicious file got through | Files flagged by the scanner are removed. Use the audit log to find downloads of the file by the factory system and staff. Tell the sites. |
| Storage or backup exposed | Rotate provider credentials. Assess whether master keys were exposed as well. If they were, treat all data as exposed. Key rotation is available (`cli rewrap`, see `../SECURITY.md`): add a new key, make it active, run the rewrap, then remove the compromised key. Data that was copied before the rotation stays exposed, because the thief holds both the ciphertext and the old key. |
| Master keys exposed | Create new keys (`gen-key`), make one active, run `cli rewrap`, and remove the exposed keys. If the key behind `HASH_KEY_ID` (API key hashes, recovery code hashes, CSRF) or `BLIND_INDEX_KEY_ID` was exposed, plan a change of those too: changing `HASH_KEY_ID` invalidates every API key and recovery code, so all partners must be told and must create new keys. Changing `BLIND_INDEX_KEY_ID` needs `rewrap --only blind_index`. Also rotate the database passwords and storage credentials. |
| The audit chain fails verification | Preserve the database and the backups immediately. Compare with backups. Treat as tampering until proven otherwise. |
| Ongoing attack from an address | Block the address at the proxy or firewall. The rate limiter is in memory per instance. |
| Total shutdown needed | Stop the API and worker processes (`docker compose -f deploy/docker-compose.prod.yml stop app worker caddy`). Partners cannot upload and the factory cannot pull. Management decides. |

After containment, rotate the secrets involved (database passwords, SMTP credentials, S3 keys, portal credentials).

## 6. Assessing the risk (for the notice)

Ask, with the partner and the DPO:

1. **Type:** confidentiality (disclosure), integrity (alteration), availability (loss)?
2. **Data:** names, dental scans (health data), identifiers, instructions, account data? Encrypted or readable to the person who had them?
3. **Number:** approximate number of people and records.
4. **Who:** who had access (insider, partner staff, outsider, another partner)?
5. **Consequences:** identity misuse, discrimination, loss of confidentiality of health data, loss of control, harm to reputation.
6. **Mitigation:** was the data unreadable? Was it recovered or deleted? Was the recipient trusted and did they confirm deletion?

Rate the risk as none, risk or high risk, and write down the reasons. Health data raises the severity.

## 7. Templates

### 7.1 Notice from K Line (processor) to an affected partner

Subject: Personal data breach affecting your data in the Portal Hub [incident number]

```
Dear [name],

We are writing to tell you about a personal data breach that may affect data you
have entrusted to us through the Portal Hub.

What we know so far
* We became aware of the incident on [date, time, time zone].
* Nature of the breach: [for example unauthorised access to an account / exposure
  of files / loss of availability].
* Data concerned: [categories, for example patient names, dental scans, case
  references, user account data] for approximately [number] people and [number]
  cases. [State whether the data was encrypted and whether keys were affected.]
* Cases or organisations concerned: [list of case references or "your whole account"].
* Likely consequences: [assessment, or "we are still assessing this"].
* What we have done: [containment steps, for example we disabled the account,
  revoked keys, closed the gap].
* What we recommend you do: [for example reset passwords, review your access log
  entries from [date] to [date], review API keys].

What happens next
We will send you more details by [date, time]. You can see the related entries in
your Access log in the Hub. Our contact for this incident is [name, role, phone,
email]. Our data protection contact is [PRIVACY_EMAIL].

As controller you decide whether to notify your supervisory authority and the
people affected. We will give you the information you need for that.

Yours sincerely,
[name, K Line Europe GmbH]
```

### 7.2 Notice to a supervisory authority (for the controller, or for K Line as controller)

Content required by art. 33(3). Use the authority's own form if it has one.

```
1. Controller: [name, address, contact]. Data protection officer: [name, contact].
   Processor involved (if any): K Line Europe GmbH, [address].
2. Date and time of the breach: [ ] Date and time of becoming aware: [ ]
   Reason for any delay beyond 72 hours: [ ]
3. Description of the breach (nature, how it happened, whether it is ongoing): [ ]
4. Categories and approximate number of data subjects: [ ]
5. Categories and approximate number of personal data records: [ ]
   Special category data (health): [yes / no, which]
6. Likely consequences for the data subjects: [ ]
7. Measures taken or proposed to address the breach and reduce harm: [ ]
8. Data subjects informed (art. 34): [yes / no / planned, how and when]
9. Cross border aspects (other member states, third countries): [ ]
10. Further information to follow by: [date]
```

### 7.3 Message to people affected (for the controller; K Line can help to draft)

```
Subject: Information about your personal data

We are writing to tell you that [short description in plain language].
What happened: [ ]
What information was involved: [ ]
What this may mean for you: [ ]
What we have done: [ ]
What you can do: [ ]
Who to contact: [name, phone, email]. You also have the right to complain to
[supervisory authority].
```

### 7.4 Internal incident record (art. 33(5))

| Field | Entry |
|---|---|
| Incident number | |
| Reported by, date, time | |
| Aware at (time and basis) | |
| Systems and data involved | |
| Number of people and records | |
| Root cause | |
| Containment actions with times | |
| Partners told (who, when, how) | |
| Authority notified (who, when, reference) or reason for not notifying | |
| People informed (who, when, how) or reason for not informing | |
| Evidence stored at | |
| Lessons learned and actions, owners, dates | |
| Closed on | |

## 8. Practice

Run a tabletop exercise at least once a year and after every major change. A good scenario: a partner API key with `patients:read` is found in a public code repository. Check that you can list everything that key read (`case.names_revealed`, `file.download` by actor type `api_key`), revoke it, and write the partner notice within the target time.
