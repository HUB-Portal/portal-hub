# Portal Hub: guide for partner staff

Welcome. This guide is for the people at your company who send cases to K Line: uploaders, quality staff, finance staff and administrators. It is written in plain language. Menu names in **bold** match the menu in the Hub.

What you see depends on your role. If a menu item is missing, your role does not include it. Ask an administrator in your company.

| Role | What it is for |
|---|---|
| Admin | Everything for your company: team, profile, integrations, all cases. |
| Uploader | Sends and manages cases, reads claims and the specification, declares material shipments. |
| Quality | Reports and follows quality claims, edits and signs the production specification. Administrators must first switch **Quality claims** and **Production spec** on for the company (see "Menu visibility for admins"), otherwise the Quality role does not see them in the menu. |
| Finance | Reads cases and exports reports (no patient names). |
| Viewer | Reads cases, claims, specification and materials. Cannot change anything, including the company logo. |

## The five questions we hear most

### 1. Where do I send and store case files?

Send them in the Hub. Open **Direct manufacturing** and drop a zip or a folder with one folder per case. You can send one case or many in the same go. Or connect your own system to the partner API.

The Hub checks every file, encrypts each one with its own key and stores it in Germany. Files are never stored in a public place. Only people with the right permission can open them, and every time someone opens a file it is written to your **Access log**.

The Hub is not a long term archive. K Line removes case files and patient names after the retention period. The default is 24 months after the case ships (your agreement may say something different). Keep your own copy of your originals. While a case still has its files you can download them as a zip: open the case and choose the download.

### 2. How do I see started, finished and shipped cases, and feed them to my ERP for invoicing?

In the Hub, open **Cases** and use the filters **Submitted**, **Production** and **Shipped**. Each case shows the four step progress bar, the carrier, the tracking number and the number of aligners shipped.

To feed your ERP you have three choices (under **ERP and API**):

* **CSV exports.** Choose a period and download `shipments.csv` (one row for every case shipped in that period) or `cases.csv`. Finance staff can do this.
* **The partner API.** `GET /api/v1/shipments?from=2026-09-01&to=2026-09-30` returns the cases shipped in a period, with the number of aligners shipped, which is usually what you invoice. `GET /api/v1/cases?updated_since=...` returns cases that changed since your last check.
* **Webhooks.** The Hub sends your system a message when a case is received (production started), changes stage, ships or is delivered.

How the dates work: a case counts as **started** when the factory receives it (status Production), and **shipped** on the day the parcel leaves (Berlin calendar day). Direct manufacturing cases do not come with a number of aligners from the K Line portal, so the Hub uses the number of upper plus lower aligners it found in your files. Templates are listed but not counted in aligners shipped. See the technical guide `docs/integration/PARTNER_API.md` for details.

### 3. How do I set up the Autobag bag format?

Open **Bag labels** (administrators) to design what is printed on each aligner bag: size, margins, wear days, up to 8 lines of text and the barcode text. Click a placeholder such as `{brand}`, `{case_id}`, `{aligner}`, `{arch}`, `{step}`, `{total_steps}`, `{wear_days}` or `{ref}` to add it. A preview shows one bag drawn to scale. One bag is printed for each aligner. Templates get no bag.

Patient names and initials are never on a bag unless you switch that on, and saving a layout that prints personal data asks for your authenticator code.

Good to know:

* Once you have a signed production specification, the bag layout lives inside it. You change it in the next draft of the specification (**Production spec**) and both sides sign it.
* K Line sends the bag text and the barcode text to its factory system, and staff can export a print file (one row for each bag). The barcode itself is drawn by the printer system.
* The exact file format that a specific Autobag machine needs is set up by K Line production. Tell your K Line contact which label layout you need so they can confirm that the machine prints it. (This match is still to be confirmed. See the open decisions document.)

### 4. Which materials should I send, and how do I track them?

Open **Materials**. Add the things you supply to K Line, such as boxes, bags, elastics, buttons or inserts. For each one, say how many are used for each case and for each aligner, and set a minimum stock.

Then, every time you send a parcel, choose **Declare a shipment**: pick the K Line site, the items and quantities, and add the carrier and tracking number if you have them. You can attach a delivery note. K Line counts what arrives and records it. If the count differs, the shipment shows as received with differences and the difference is highlighted.

The page shows what is on hand at each K Line site, what is on the way, how many days the stock will last and whether it is low. When a case ships, the Hub deducts what that case used. When stock falls below your minimum, your company gets a notice in the Hub and the people who manage materials (administrators) get an email. A notice is sent at most once a day for each item and site.

### 5. How do quality claims and reworks work?

If aligners arrive with a fault, open the case and choose **Report an issue**. Pick each affected aligner, say what is wrong from the list (for example scratches, trim line not as specified), add a short summary, photos or videos, and, if you like, the clauses of your specification that apply. Claims can be opened once K Line has received the case.

K Line reviews the claim. You can chat with K Line in the claim, and K Line may ask you for more. Then K Line decides:

* **Accepted with remake:** the Hub creates a **rework** case at once, marked rush, with the same files. You do not have to upload anything again. It appears under the original case.
* **Accepted with a credit or no action**, or **rejected:** you get the decision and the reason.

Different from a claim is a **replacement order**: if a patient loses or breaks aligners that were made correctly, choose **Order replacement** on a shipped case and select the aligners. Replacements are for standard cases (cases that were created through the partner API or by K Line staff). They are not available for direct manufacturing cases.

## Getting started

### Register your company

1. Open the registration page from the sign in screen (**Register your company**). If you do not see it, registration is closed. Ask your K Line contact for an invitation.
2. Fill in your company name, country, your name, your work email address, and, if you like, your website and how many cases you expect. Add your **case address**: the street, postal code, city, state or province, country and phone number where K Line sends your cases back to (if your country has no states, write `N/A`). The recipient name, company name and email address of the case address start as the ones you typed above, and you can change all of it later in your company profile. Tick the boxes to confirm that you may act for your company and that you have read the privacy notice. You add your company logo after you sign in.
3. Free email addresses such as Gmail are accepted but K Line looks at them more closely. Throw away email addresses are not accepted.
4. You always see the same thank you message, so no one can use the form to find out who has an account.
5. Check your email. Click the link within 48 hours and choose a password (at least 12 characters, not a common one or a common one with numbers added, no runs such as `abcd`, `1234` or `qwer`, no repeated blocks, not only one kind of character under 16 characters, and not containing your name or email). Three or four unrelated words work well, for example `Blue-Harbour-Kettle-2026!`.
6. Set up the authenticator app (see below). Save your ten recovery codes.

If you never confirm your email address, the registration is deleted after 7 days.

### Approval by K Line

Until K Line approves your company, you can sign in, fill in your company profile, add logos and documents, read and propose the production specification and use your account. These are locked until approval: sending case files, material shipments, team invites, API keys and webhooks. The **Overview** shows a getting started list:

1. Secure your account (an administrator has an authenticator app).
2. Complete your company profile (legal name, VAT ID for EU countries, address, at least one contact).
3. Add your company logo. It is required: K Line cannot approve a company without one. Any team member except a viewer can add it.
4. Add your case address (the company address is filled in at registration, check it is right; every person can also add their own in **Account**).
5. Agree a production specification (one is proposed or active).
6. Data processing agreement on file (K Line records it).
7. Approval by K Line.

K Line also needs a production site for your company and, if your company is in the EEA and a site is outside the EEA, Standard Contractual Clauses on file. K Line handles that.

### Signing in with the authenticator app

Everyone uses two steps: your password, then a six digit code from an authenticator app (for example the apps from Google, Microsoft or your password manager).

1. **First time:** scan the QR code shown in the Hub with the app (or type the key). Enter the six digit code to confirm. The Hub then shows **ten recovery codes**. Save them somewhere safe. Each works once.
2. **Every time:** enter your email and password, then the current code from the app.
3. **Lost your phone?** Use a recovery code instead of the app code. Then make new codes under **Account**. If you have no codes, ask an administrator in your company to reset your authenticator. You then set it up again.
4. **Wrong codes:** wrong codes are counted for you across all your sign ins. Five wrong codes in 15 minutes lock your account for 15 minutes (the lock doubles each time, up to 24 hours) and sign you out everywhere; signing in again with your password does not give you new tries. Five wrong passwords lock your account in the same way. A correct code clears the count. An administrator in your company can unlock you on the **Team** page (**Unlock**), and **Forgot your password?** also lifts the lock.
5. **Sensitive actions** (creating API keys, inviting people, signing the specification and similar) ask for a fresh code. It then counts for 10 minutes.
6. You are signed out after 30 minutes of doing nothing, and after 12 hours in any case.

Forgot your password? Choose **Forgot your password?** on the sign in page. The link works for 60 minutes.

## Sending cases

You send cases in the Hub with **Direct manufacturing**. K Line makes them through the K Line customer portal.

You need these details for every case:

* **First name** and **last name** of the patient. They are stored encrypted and hidden on screen.
* A folder per case, named like `Marc Alonso` (first name, last name). A number in front of the name is ignored.

### Direct manufacturing, step by step

1. Put one folder per patient in a zip (or drop the folders). Name each folder `<first name> <last name>`, for example `Marc Alonso`. Inside you can have `STL`, `PTS` and `CSV` sub folders, PDFs, photos and other documents. Do not put the product type in the zip. It is not used (clear aligners are assumed). One zip can be up to 2 GB with up to 5,000 files. Your browser reads it. Nothing is sent yet.
2. Open **Direct manufacturing** and drop the zip or folder.
3. On the review screen, check every row. The Hub shows the first name and last name it found. Names in different orders are common, so use **Swap names** when they are the wrong way round. A folder name with a comma, such as `Alonso, Marc`, is read as last name first. Three or more words are split as first name then the rest, and the row is marked for review. A copy ending such as `(2)` is removed.
4. A case is blocked until the first name and last name are both there. Names can be at most 50 characters. You can change the names in the row.
5. Open a row to check its files. Each STL (3D model) and PTS (trim line) needs an arch (upper or lower) and a step. Fix any that the Hub could not read. You can switch a file off. Instructions are read from a text or Word file (`.txt`, `.md`, `.rtf`, `.docx`) in the folder, and you can edit them. At most 8,000 characters. Old `.doc` files are not read.
6. Set the brand, then start. The Hub creates the cases, uploads the files and checks them. Keep the page open. If the connection drops, it carries on where it stopped. With the automatic option it submits the clean cases. Cases with problems stay drafts for your review.
7. Watch **Batch result** for each case. The Hub then sends each submitted case to the K Line customer portal. If that fails you see an error with a **Retry** action. If the portal connection is not set up (**Portal connection**, for administrators) the push fails with a clear message.

Every direct manufacturing case is sent with a **case address**. It is the address of the person who sent the case (their own, see **Account**, **Case address**) when that person has saved one, and otherwise your company's address (see **Company profile**). If neither is complete, the Hub tells you before you upload anything ("Add your case address in the company profile, then press Try again."). The K Line portal does not allow the address of a submitted direct case to be changed, so changing an address later does not change cases that were already sent.

Direct manufacturing needs the **Portal connection** (administrators): the portal address, API key and user ID that K Line gave you. Saving asks for your authenticator code. Use **Test connection** to check it.

Nothing is silently corrected. If the Hub finds something odd, it tells you and waits for your decision.

### Folder and file names

The Hub groups files into cases by folder. Use one folder per case. These sub folders never become cases: `Upper`, `Lower`, `Maxilla`, `Mandible`, `Oberkiefer`, `Unterkiefer`, `OK`, `UK`, `UJ`, `LJ`, `U`, `L`, `Steps`, `Stages`, `Subsetups`, `Setups`, `Aligners`, `Trays`, `Models`, `STL`, `PTS`, `CSV`, `Trim lines`, `Cut lines`, `Templates`, `Attachments`, `Exports`, `Files`, `3D`, `Scans`, `Prints`, `Output`, `Results`, `Photos`, `Images`, `Pictures`, `Documents`, `Docs`, `Reports`, `Prescriptions`, `Rx`, `Instructions`, `Notes`, `PDFs`, `Other`, `Misc`, `Extras` (also followed by a number).

**Numbers in folder names.** Direct manufacturing does not use a patient ID. A number of 4 or more digits at the start of the folder name (for example `55813 Marc Alonso`) is ignored when the names are read.

**Arch.** Upper: `upper`, `maxilla`, `oberkiefer`, `superior`, `U`, `UP`, `OK`, `SUP`, `MAX`, `MX`, `UJ`, `TOP`. Lower: `lower`, `mandible`, `unterkiefer`, `inferior`, `L`, `LOW`, `UK`, `INF`, `MAND`, `MD`, `LJ`, `BOTTOM`. Note that `UK` means lower (Unterkiefer) and `OK` means upper (Oberkiefer).

**Step.** `Step 4`, `Stage 4`, `Subsetup 4`, `Setup 4`, `Aligner 4`, `Tray 4`, or `U04` / `L06`, or a number at the end of the name.

**Templates.** A file with `Template` in its name is a template (step 0 if there is no step). A `_T` at the end marks a template for that step: `90002_U01_T.stl` is the template for upper step 1. A template never clashes with the aligner of the same step.

Examples:

| File | The Hub reads |
|---|---|
| `90001_U01.stl` | case 90001, upper, step 1, model |
| `90001_L11.pts` | case 90001, lower, step 11, trim line |
| `90002_U01_T.stl` | case 90002, upper, template for step 1 |
| `Upper/Step 04.stl` | upper, step 4 |
| `Lower/L06.pts` | lower, step 6, trim line |
| `55813 Marc Alonso/Upper/U01.stl` | case 55813, upper, step 1 |
| `90001_U01.csv` | case 90001, upper, step 1, laser marking text |

Allowed file types for cases: `stl`, `pts`, `pdf`, `csv`, `svg`, `txt`, `xml`, `json`, `jpg`, `jpeg`, `png`. Programs and scripts are always refused. A file can be at most 512 MB, and a case can have at most 600 files.

## File checks and warnings

The Hub scans every file for malware and checks its content. Results come in two kinds.

**Errors stop you from submitting.** Examples: there is no STL at all; a model or trim line has no arch or step; two files are for the same aligner; a file failed a check (for example malware, a PDF that contains scripts, a file that is not a valid STL); files are still uploading or being checked.

**Warnings need your clear yes.** You read them and confirm ("I have read the warnings and want to submit anyway"). The confirmation is stored with the case. Examples:

* A trim line is missing for an aligner (only if your company asked for a trim line for every aligner).
* A trim line has no matching model, or is not on its model.
* Steps are missing between the first and last step.
* The model looks too big or too small (the units may be wrong), has open edges or holes, or has triangles with no area.
* A trim line is not closed, has a break, has very few points or fewer points than it says.
* A CSV file has cells that could run as a spreadsheet formula, or is not UTF-8 text.
* A PDF contains embedded files or is password protected.

The 3D viewer on the case page shows each model with its trim line. Open trim lines are drawn in red.

## Case status: the four step progress bar

Every case shows four steps: **Draft**, **Submitted**, **Production** and **Shipped**.

| Step | What it means |
|---|---|
| Draft | You are still adding files. K Line does nothing yet. |
| Submitted | You sent it. Caption "Files checked" means K Line has approved it for production. "On hold" means it needs you. |
| Production | The factory has the case. The caption shows where it is, for example "3D printing" or "Quality check". |
| Shipped | It is on its way. The carrier, tracking number and aligners shipped are shown. The caption "Delivered" follows later. |

A cancelled case shows a Cancelled notice instead of a current step. You can cancel a case while it is a draft, submitted, on hold or ready. After the factory has it, ask K Line.

For direct manufacturing cases, the Hub reads the status from the K Line portal about every 10 minutes (the case page has a refresh button). You see the portal's own words, such as "In planning", under Submitted.

### Holds

K Line or the factory can put a case **on hold** if something needs your attention. You see the reason on the case and get a notice. Fix the files or details, then choose **Submit again**. The case always goes back to K Line's review (status **Submitted**), also when your company normally sends cases straight to production, so K Line can check the fix before it goes on. K Line then approves it again. You can still change the instructions in this state.

### Erasing the data of a case

The Hub removes case data by itself after your retention period. If you need it gone sooner, for example because a patient asked, a company administrator can erase a case at any time.

1. Open the case and choose **Erase case data**. The button is only there for administrators and only for cases that are not drafts (delete a draft instead).
2. Read what is removed and what stays. Type the case reference to confirm, then enter the code from your authenticator app.
3. The data is removed at once. You cannot undo it.

Removed: all files of the case, the patient name, the instructions, the case ID, and the text people typed around the case (hold reasons and the notes and messages of quality claims). Kept: the reference, status, dates, counts, the shipping details and the history without free text. Your access log records who erased the case and when, and your administrators get a notice.

For **direct manufacturing** cases the K Line portal keeps its own copy. Ask K Line to remove it there. A replacement or rework case made from the original keeps its own data and has to be erased separately.

### Instructions

You can change a case's instructions until the factory starts. After that you see "instructions locked". Changes after submission are noted on the case for K Line intake.

## Production specification

Your **Production spec** is the agreement on how your aligners are made: material, trim, hooks, templates, finish, marking, packaging, records and the bag layout. It has numbered clauses (for example TR-2).

* Either side can draft a new version. A draft is private until it is proposed.
* After it is proposed, the other side can read it and **sign** or **reject** it (with a reason). Signing asks for a fresh authenticator code. Only people with the signing permission can sign (admins and quality on your side).
* A version becomes **active** when both sides have signed. It cannot be edited again. Only one version is active at a time.
* Every case records the version that was active when it was submitted.
* The page shows a **hash check**: your browser works out the fingerprint of the text and compares it with the one stored at signing. If they differ, do not rely on that version and tell K Line right away.
* You can compare any two versions to see what changed.

## Team

Administrators open **Team** to invite people, change roles, disable or re-enable people, resend invitations and reset someone's authenticator. A person who is locked out (too many wrong passwords or codes) shows a **Locked** badge with an **Unlock** button; unlocking asks for your authenticator code. Invitations work for 7 days. Inviting and role changes ask for a fresh authenticator code. You cannot change your own roles, and there must always be one active administrator. Team invites unlock after K Line approves your company.

## Company profile

Open **Company profile** to keep your legal name, VAT ID, address, **case address**, **company logo**, contacts for operations, quality, finance and IT, brand logos, brands, documents (quality criteria, packaging and others) and your **case ID pattern** up to date. The pattern (optional) teaches the Hub how your case IDs look. There is a box to try it. You can also ask the Hub to require a trim line for every aligner. You can see the agreements K Line has recorded with you and the K Line sites your cases may go to. After approval the country cannot be changed here, because it decides where your cases may be produced. Ask K Line if it must change.

### Case address

The case address is the shipping address K Line keeps on every direct manufacturing case. It has nine fields, all required: company name, recipient name, street, postal code (at most 10 characters), city, state or province (at most 64, write `N/A` if your country has none), country, phone number (at most 15 characters, digits, spaces and `+ - ( )`) and email address. Administrators can change it. Everyone else can read it. It is the **company address**: the default used when a person has no case address of their own.

### Your own case address

Every person in your company, whatever their role, can have their own case address. Open **Account** and find the **Case address** card. It shows which address your cases will use: **Your own address** or **Your company's address**. To set your own, check the form (it starts from the company address, with your name and email address as the recipient, so change only what differs) and press **Save my case address**. All nine fields are required. To go back to the company address, press **Use the company address instead** and confirm.

The address used for a direct manufacturing case is the one of the person who **created** the case (who uploaded the folder), not of the person who presses submit. If that person has no complete address of their own, the company address is used. Cases created through the partner API use the company address. Cases that were already sent keep the address they were sent with, so changing your address only affects cases you create or send from then on. You only ever see your own address and the company one, never a colleague's.

### Company logo (required)

Every company must have a logo. Everyone in your company sees it in the top bar after signing in, next to the company name. Until you add one, a banner reminds you on every page, and K Line cannot approve your company.

**Who can change it:** every team member except viewers (administrators, uploaders, quality and finance). Open **Company profile** and use **Choose logo**, **Replace logo** or **Remove logo** on the **Company logo** card. Viewers can see the logo but not change it. The old logo file is deleted when you replace it. Every change is written to your **Access log** with the name of the person, and your administrators get a notification in the bell ("Name changed the company logo"). Brand logos stay with administrators.

* **Format:** PNG (best, with a transparent background), SVG (plain shapes only, no scripts) or JPG.
* **File size:** at most 2 MB.
* **Size:** at least 400 x 120 pixels and at most 4,000 x 4,000. We recommend 800 x 240 pixels (landscape, about 3 to 1) so it stays sharp on high resolution screens. The width must be between 1 and 6 times the height. An SVG needs a `viewBox` (or a width and a height) in the same range.
* **Look:** leave about 10 percent empty margin around the artwork, use a transparent background, and make sure it can be read on a white bar.

If the Hub refuses a logo it tells you why and repeats these rules.

### Menu visibility for admins

Administrators decide which optional menu items the other people in the company see. Open **Company profile** and find the **Menu** card (only administrators see it). There are three switches:

* **Show Quality claims to everyone in the company.** Controls the **Quality claims** page, the **Report an issue** button on a case and the claims listed on a case.
* **Show Production spec to everyone in the company.** Controls the **Production spec** page and the links to it. The case page then shows the spec version as plain text.
* **Show Materials to everyone in the company.** Controls the **Materials** page.

All three are off for everyone except administrators until an administrator switches them on, in every company, including existing ones. Press **Save**. The menu of the other people updates the next time their page refreshes or they return to the browser tab, and administrators see the change at once. Administrators always see these items.

This only changes what the menu shows. What each person can do still depends on their role. For example, **Order replacement** on a case is not a claim, so it stays available to everyone who may create cases. If someone opens a page that is switched off for them, for example from a bookmark, the Hub takes them to the overview.

## ERP and API

Administrators (and finance for exports) find **ERP and API** in the menu. Everything here is also described for developers in `docs/integration/PARTNER_API.md`.

* **API keys.** Create a key for each system. Choose only the scopes it needs: read cases, write cases, read patient names (think twice: this exposes names), read claims, read materials. You can limit a key to certain IP addresses and set an expiry of up to 730 days. The key is shown once. Copy it straight into your secret store. You can have 20 active keys. Revoke a key at any time.
* **Webhooks.** Add the web address your system listens on (it must be `https`) and choose the events. The Hub signs each message so you can check it is genuine. The secret is shown once. Use **Send test** to check your endpoint. Failed messages are retried over about a day, and a webhook that keeps failing is switched off and you are told. The delivery history shows what was sent.
* **Exports.** Download `cases.csv` and `shipments.csv` for a period. Patient names are left out unless you tick the box, which needs the right permission and a fresh authenticator code. The export is then logged as a bulk name reveal.
* Webhook messages never contain patient names, notes, reasons or file names. They carry references and counts. For a direct manufacturing case created without a case ID, the case ID in a message is empty; if you sent one, treat it as personal data in your own logs.

## Account and security

Under **Account** you can change your password (the new one must be different from the current one), see where you are signed in and sign out other devices, make new recovery codes, and switch email notices on or off. Emails are short and have a link, never patient data. Several notices about the same case within 15 minutes are combined.

The **Access log** (administrators) shows who signed in, changed settings, showed a patient name, opened your files or read your data, including K Line staff and the K Line factory system. Patient names are masked on screen (for example `M*** A*****`). Showing a name is a deliberate click and it is logged.

## Frequently asked questions

**Can I send cases before K Line has approved us?** No. Sending cases unlocks when K Line has approved your company and a data processing agreement is on file. You can prepare your profile in the meantime.

**Why can I not see the patient name?** Names are masked. People with the right role can choose to show a name, and every reveal is logged.

**A file says "rejected". What now?** Open the case and read the reason. Replace the file or remove it, then submit. A file with malware is removed at once.

**Can I add files after I submit?** Only while the case is a draft or on hold. Otherwise ask K Line to put it on hold, or start a new case.

**Can I change a case ID?** While the case is a draft or on hold.

**How long does K Line keep my data?** Case files and patient names are removed after the retention period (24 months after shipping by default), or 30 days after a cancelled case. Cancelled cases and old drafts (30 days without a change) are removed sooner. Ask your K Line contact for the periods in your agreement.

**Can I have the data of one case removed before the retention period ends?** Yes. A company administrator uses **Erase case data** on the case page (see "Erasing the data of a case").

**I got a "step up required" message.** Enter a fresh code from your authenticator app. It then counts for 10 minutes.

**Who do I contact?** The support address shown in the Hub (and in every email), or your K Line account team. For privacy questions use the privacy contact on the privacy page.
