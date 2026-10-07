# Demo script: 20 minutes

A walkthrough of every feature of the Portal Hub, with the demo accounts, in the order that tells the best story. "Click" is what to do. "Say" is what to tell the audience.

All data is made up. Companies: Acme Aligners, Contoso Smile, Fabrikam Dental Lab. Patient names and numbers in the samples are fictional.

## Before you start (5 minutes, not part of the 20)

```bash
npm run db:up
npm run migrate
npm run seed          # wipes and recreates the demo data, including the audit log
npm run dev           # API and worker on http://localhost:4000
npm run dev:web       # web app on http://localhost:5173
```

Open http://localhost:5173 (or http://localhost:4000 after `npm run build`).

* Demo password for every account: `Demo2026PartnerHub`. The sign in page lists the accounts. Click one to fill in the form. The current authenticator code is shown next to each account (demo mode only), and the code changes every 30 seconds.
* Self registration is off by default. You do not need it for this script, because Contoso Smile and Fabrikam Dental Lab are already seeded as registrations. To show the registration form itself, set `SIGNUP_ENABLED=true` in `server/.env` and restart the API.
* Sample folders for the sending step: sign in as `upload@acme.demo`, open **Direct manufacturing**, and use the "Try it with sample folders" card (demo mode only) to download `sample-cases.zip` (route `GET /api/demo/sample-cases.zip`). It holds four made up cases, with fresh five digit numbers on every download, so you can send it again and again:
  1. `Case NNNNN` with `Upper` and `Lower` sub folders (steps 1 to 3, models and trim lines), a Word instructions file and a PDF plan.
  2. `Case NNNNN` with flat files such as `NNNNN_U01.stl`, `NNNNN_U01_T.stl` (a template) and an `instructions.txt`.
  3. A fictional patient folder (for example `50133 Lucia Garcia`) with `Maxilla` and `Mandible` sub folders and an RTF instructions file.
  4. `Case NNNNN` whose upper step 3 trim line is open on purpose, so the checks have something to show.
  Every folder is named `NNNNN First Last` (made up names), so the review screen already shows the first and last name (the number is ignored). Keep the zip on your desktop.
* For the factory system steps and the API step, open a terminal in the repository root (Git Bash on Windows) and run:

```bash
KEY=$(grep '^kph_' server/data/demo-keys.txt | sed -n 1p)       # demo factory system key (written by the seed)
MYKEY=$(grep '^kph_' server/data/demo-keys.txt | sed -n 2p)     # demo partner key for Acme (all partner scopes)
BASE=http://localhost:4000
```

* The seed creates about 18 Acme cases that cover every status (AC-1001 draft, AC-1002 submitted, AC-1003 on hold with an open trim line, AC-1004 ready, AC-1005 received, AC-1006 to AC-1011 at each production stage, AC-1012 to AC-1014 shipped, AC-1015 delivered, AC-1016 cancelled), a replacement and a rework case, two claims (one closed with a rework, one in review), factory events including one unmapped code and one duplicate, and K Line access entries in the audit log. Shipped and received cases hold small real (encrypted) files. The other cases have no files.

* Use two browser profiles or windows (one for Acme, one for K Line), so you do not have to sign out all the time.

## Timing

| Part | Minutes | Who |
|---|---|---|
| 1. Sign in and two factors | 1 | upload@acme.demo |
| 2. Direct manufacturing: send cases | 5 | upload@acme.demo |
| 3. K Line intake, route, hold, release | 3 | intake@kline.demo |
| 4. Factory system events | 2 | terminal, then the partner view |
| 5. Claim and rework | 2 | admin@acme.demo (switch the menu items on), quality@acme.demo, quality@kline.demo |
| 6. Specification signing | 2 | quality@acme.demo, quality@kline.demo |
| 7. Materials | 1 | admin@acme.demo, chaves@kline.demo |
| 8. API key and webhook | 1.5 | admin@acme.demo |
| 9. Registration and approval | 1.5 | admin@kline.demo |
| 10. Audit chain and security points | 1 | admin@kline.demo |

## 1. Sign in and two factors (1 minute)

Click: open the sign in page, choose `upload@acme.demo`, sign in, then type the six digit code shown beside the account.

Say: "Everyone signs in with a password and an authenticator code. There is no way around it, even for administrators. Sessions last 30 minutes idle and 12 hours at most. Five wrong passwords lock the account, and five wrong codes end the session."

## 2. Direct manufacturing: send cases (5 minutes)

Click: **Direct manufacturing**. This is the only way partners send cases in the Hub. Drop the sample zip.

Say: "Your browser reads the zip. Nothing has left the machine yet. The Hub works out the cases, arches and steps from folder and file names. The server never unpacks an archive. Each case is a folder named with the patient's name, like `Marc Alonso`."

Click: on the review screen, show the parsed rows: the case with upper and lower sub folders, the one with flat files, the one named after a patient and the one with the open trim line. Show the file map with arch and step. Show that `_T` files are templates, and that the Word, RTF and text files became the case instructions.

Say: "Each folder name carries the first name and last name. A case needs both, and partners order names differently, so you can check each row and swap the names if needed."

Click: look at the parsed names, click **Swap names** on one row to show how the order can be corrected, and click it again to restore it.

Say: "You check the mapping and fix anything before it goes. Nothing is silently corrected."

Click: leave **Submit automatically when all checks pass** ticked, start the batch.

Say: "Each file goes up in 8 MB chunks, every chunk with its own checksum, so a bad connection resumes where it stopped. On the server each file is encrypted with its own key, scanned for malware, then checked: is the 3D model closed, is the trim line closed, does it sit on its model."

Click: when it finishes, open the batch result.

Say: "These cases are not pulled by the factory system. The Hub pushes each one to the K Line customer portal, in the background, with retries, and then follows its status." Point at the note "Demo only, nothing was sent to the K Line portal".

Click: open **Cases**. Open the clean case and show the 3D viewer with the trim line. Open the case with the open trim line (it stayed a draft): show the red trim line and the warning. Choose **Submit case**, tick "I have read the warnings and want to submit anyway".

Say: "Errors block the case. Warnings need an explicit yes, and the yes is stored with the case."

Click: show the four step progress bar on a submitted case: Draft, Submitted, Production, Shipped. Patient names show masked (for example `L***** G*****`). Choose the eye icon to reveal one name, then open **Access log** (switch to `admin@acme.demo` if the uploader cannot see it) and show the reveal entry.

Say: "Four steps are all a partner needs to see. Every name reveal is logged."

## 3. K Line intake: route, hold, release (3 minutes)

Click: switch to the K Line window. Sign in as `intake@kline.demo`. Open **Intake**.

Say: "K Line sees what is waiting, what is on hold and what is ready."

Click: on the **To review** tab open the seeded case `AC-1002` (Iris Petrov, submitted, with files and a prescription in the instructions). Choose the Cairo site (EG-CFZ) and route it.

Say: "Acme is a Portuguese company. Cases from the European Economic Area may only be produced in the EEA, in a country with an adequacy decision, or where Standard Contractual Clauses are on file. There are none for Acme, so the Hub refuses this. That is the transfer gate." (The error reads `transfer_blocked`.)

Click: route the case to Chaves (PT-CHV) instead. It becomes ready with a due date.

Click: on the **Ready** tab open `AC-1004` (Lena Fischer; note that its instructions were changed after submission) and choose **Hold**. Type a reason ("Please confirm the shipping address."). Show the **On hold** tab.

Switch to the Acme window: open the case. Show the hold notice with the reason and the bell notification.

Say: "The partner sees why, fixes the details and submits again, or K Line can release it."

Click: back at K Line, choose **Release** on `AC-1003` (Tomas Berg, already on hold because of an open trim line). It goes back to the review tab. Also point at **Partners** and **Sites**: the country flags on the site rows decide the gate.

## 4. Factory system events (2 minutes)

Say: "The factory system is the source of truth. It pulls cases, acknowledges them and reports events. Here is the demo key."

```bash
curl -s "$BASE/api/mes/v1/intake?site=PT-CHV" -H "Authorization: Bearer $KEY"
```

Show that file names are canonical (`upper/U01.stl`), each file has a checksum, and there is no patient name. Copy the `ref` of `AC-1002`, the case you routed to Chaves in part 3 (its `ref` is shown in the intake list and on the case page).

```bash
REF=<the ref of AC-1002>
curl -s -X POST "$BASE/api/mes/v1/cases/$REF/ack" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"mes_case_id":"MES-DEMO-001"}'

curl -s -X POST "$BASE/api/mes/v1/events" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "events": [
    { "event_id": "DEMO-EVT-1", "case_ref": "'$REF'", "stage_code": "PRINT", "occurred_at": "2026-09-30T08:00:00Z" },
    { "event_id": "DEMO-EVT-2", "case_ref": "'$REF'", "stage_code": "THERMO", "occurred_at": "2026-09-30T10:00:00Z" }
  ] }'
```

Show the Acme window: the progress bar moves to Production with the caption "Thermoforming". Send the same request again.

Say: "Replaying the same events changes nothing: they come back as duplicates. Stages only move forward."

Now ship it, with the details the partner and their ERP need:

```bash
curl -s -X POST "$BASE/api/mes/v1/events" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "events": [ { "event_id": "DEMO-EVT-3", "case_ref": "'$REF'", "stage_code": "SHIP",
                "occurred_at": "2026-09-30T15:00:00Z", "carrier": "DHL Express", "tracking_number": "DEMO0000042", "aligners_shipped": 24 } ] }'
```

Show the case as **Shipped** with carrier, tracking number and 24 aligners, and the new notification. As `admin@acme.demo`, open the **Access log**: entries "K Line service" for the intake read and any file downloads.

Say: "A shipping event also starts the retention clock, books the materials the case used, and emits the partner's webhooks. The partner can see every read the factory system made."

Click: K Line window, `admin@kline.demo`, **MES integration**. Show the event log with your events, a duplicate and an error for the unmapped stage code `XRAY9` (seeded). Open the stage map and add `XRAY9` with a target of your choice.

Say: "An unknown code is never guessed. It is logged as an error, K Line maps it, and the factory system sends the same event again. There is also a CSV import for factories that cannot call the API."

## 5. Claim and rework (2 minutes)

Click: first sign in as `admin@acme.demo` (in the Acme window), open **Company profile** and find the **Menu** card. Switch on **Show Quality claims to everyone in the company** and **Show Production spec to everyone in the company** (and **Show Materials** while you are there), then press **Save**. By default these three items are off for everyone except administrators, so without this step the Quality role sees no **Quality claims** and no **Production spec** in its menu.

Say: "Administrators decide which optional pages their people see. This only changes the menu. What each role may do is decided by its permissions."

Click: sign out and sign in as `quality@acme.demo` (or reload its window). Open **Quality claims** and show the two seeded claims: one closed with a rush rework case, one still in review. Then open the case you shipped in part 4 (or a seeded shipped case with files, such as `AC-1013`). Choose **Report an issue**. Choose two aligners, the defect "Scratches" for one and "Trim line not as specified" for the other, write a summary, add a photo, open the claim.

Say: "Claims are tied to specific aligners and defects, with evidence, and can cite clauses of the signed specification."

Click: K Line window, sign in as `quality@kline.demo`. Open **Quality claims**, open the claim, choose **Start review**, write a message. Choose the decision **Accepted** with the resolution **Remake**. Add a root cause and a corrective action.

Say: "Accepting a remake creates a rush rework case in one step. The files are not uploaded again: the new case points at the same encrypted bytes."

Click: show the rework case linked from the claim and on the original case (priority rush, status ready). In the Acme window show the claim decision and the rework case under "Follow up cases".

## 6. Specification signing with hash check (2 minutes)

If you did not do the menu step at the start of part 5, do it now: as `admin@acme.demo` open **Company profile**, find the **Menu** card, switch on **Show Production spec to everyone in the company** (and **Show Quality claims**) and press **Save**. The Quality role does not see **Production spec** until an administrator has switched it on.

Click: Acme window, `quality@acme.demo` (reload the page or the tab so the menu refreshes), **Production spec**. Show version 1 (active) and version 2 (proposed by K Line).

Say: "The production specification is versioned and signed by both sides. Every case records the version that applied."

Click: open version 2. Show the **hash check**: "Your browser worked out the same fingerprint as the one stored with the signatures". Open **Show the fingerprints**. Choose to compare it with version 1 and show the added clause and the changed clause. Choose **Sign**, enter a fresh authenticator code.

Say: "The browser recomputes the SHA-256 of the exact text. If anyone changed the text after signing, this badge turns red."

Click: K Line window. `quality@kline.demo`, **Partner specs**, open Acme, open version 2 and sign as K Line. Version 2 becomes active and version 1 is superseded. New cases now carry version 2.

## 7. Materials (1 minute)

Click: Acme `admin@acme.demo`, **Materials**. Show the box and bag items, the usage rules, stock per site, days of cover and the low stock marker. Choose **Declare a shipment**, pick Chaves, add quantities and declare.

Click: K Line window, `chaves@kline.demo` (a production user tied to Chaves), **Partner materials**, open the shipment and receive it with one quantity lower than declared.

Say: "K Line counts what arrives. A difference shows as a discrepancy, and stock is booked with the counted quantity. The shipped case from part 4 already deducted its materials."

## 8. API key and webhook test (1.5 minutes)

Click: Acme `admin@acme.demo`, **ERP and API**, **API keys**, **Create a key**. Name it "Demo ERP", tick only `cases:read`, create it (enter a fresh code). Copy the key from the one time box.

```bash
MYKEY=kph_...            # paste the key you just created (the seed also wrote a demo partner key, see the start of this script)
curl -s "$BASE/api/v1/shipments?from=2026-09-01&to=2026-09-30" -H "Authorization: Bearer $MYKEY"
```

(Change the dates to the current month if you run the demo on another day.)

Say: "This is how a partner feeds their ERP for invoicing: the shipments in a period, with aligners shipped. No patient names without the separate patients:read scope. A lost key cannot be shown again."

Click: **Webhooks**, **Add a webhook**. In a second terminal start a tiny receiver:

```bash
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{console.log(q.headers['x-kph-event'],q.headers['x-kph-signature']);console.log(b);s.end('ok')})}).listen(9000)"
```

Use the address `http://localhost:9000/hook` (plain http to localhost is allowed only in development), tick the shipped event, save (fresh code), copy the secret. Choose **Send test**.

Say: "Every message is signed so the partner can prove it came from the Hub. Real addresses must be https, and the Hub refuses private or internal addresses, even if a name is later pointed at one."

## 9. Registration and approval (1.5 minutes)

Click: K Line window, `admin@kline.demo`, **Partners**, tab **Waiting for review**. Show Contoso Smile (confirmed) and Fabrikam Dental Lab (email not confirmed).

Say: "Anyone can register, but nothing opens until the email is confirmed and K Line approves. The form always gives the same answer, so it cannot be used to find out who has an account."

Click: open Contoso Smile. Show the registration card and the compliance gates. **Activate** is disabled with the reasons "data processing agreement required" and "production site required". Add a DPA agreement (enter a fresh code) and give the partner the Chaves site. **Activate**.

Click: with `SIGNUP_ENABLED=true`, open the registration page in a private window. In demo mode it lists Fabrikam's confirmation link (no email leaves the computer). Open it, choose a password and set up the authenticator. With signup switched off the page only says that registration is closed. Then sign in as `owner@contoso.demo` to show that the getting started list is complete and the locked features now work.

Optional: fill in the form with invented details to show the validation and the identical thank you message. Do not use the name of a real company.

## 10. Audit chain and security points (1 minute)

Click: `admin@kline.demo`, **Audit log**, choose **Verify chain**. It reports the number of entries checked.

```bash
# optional: prove that even the database owner cannot change the log
docker compose -f deploy/docker-compose.dev.yml exec db psql -U kph_owner -d kph -c "UPDATE audit_log SET action = 'x' WHERE seq = 1"
# expected: ERROR: audit_log is append only
```

Say: "Every entry includes the hash of the one before it. The application's database role can read the log but not change it, and a trigger stops everyone else. If a single entry is altered, verification names the first broken entry."

Close with the security points:

* Two factors for everyone, step up for sensitive actions, server side sessions and CSRF protection. K Line staff can also sign in with Google Workspace when it is configured (`OIDC_*` settings), but only with an existing staff account, and the authenticator code is still required.
* Every file has its own key, keys live outside the database. Patient names are encrypted, masked and their reveal is logged.
* Two layers of tenant isolation: the application and PostgreSQL row level security under a restricted role.
* Partners see every K Line access to their data, including the factory system.
* Malware scanning, content checks, no third party requests from the browser, strict headers.
* Webhooks and portal addresses are protected against server side request forgery.
* Production refuses to start with demo mode, no scanner, no SMTP or a non https address.
* Data is kept only as long as the retention schedule says, then purged, and the GDPR drafts in `docs/gdpr/` describe it for Legal and Compliance review.

## Reset

Run `npm run seed` again to get a clean demo. It wipes every table, including the audit log, and is refused in production.
