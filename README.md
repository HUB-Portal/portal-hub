# Portal Hub

A secure web platform where partner companies (aligner brands, dental labs and clinics) send clear aligner case files to K Line Europe GmbH for manufacturing.

The Hub reads the case, arch and aligner step from folder and file names. It checks every file (3D model, trim line, malware, active content), encrypts each file with its own key and stores it in Germany. Clean cases go to a K Line factory. The factory system (MES) pulls them through an API and reports progress back. Bulk "direct manufacturing" cases go to the K Line customer portal instead.

Patient data is health data under the GDPR. Security and privacy are part of every feature. Read `docs/SECURITY.md` and the drafts in `docs/gdpr/` before you handle real data.

All demo companies are fictional: Acme Aligners, Contoso Smile and Fabrikam Dental Lab. No real partner name appears in the code or the documents.

## What it does

* Partner portal: sending cases through Direct manufacturing (a zip or folder with one folder per case; the drop zone stays pinned at the top, every drop adds to the list and uploads at once, names and patient ID are optional), cases and a four step progress bar, quality claims, replacements and reworks, signed production specification, bag labels, supplied materials, company profile, team, ERP and API (keys, webhooks, CSV exports), access log.
* K Line console: intake and routing, holds, manual stage updates, partners and onboarding, sites and the transfer gate, factory (MES) integration, service keys, staff, claims, specifications, materials, audit log with chain verification.
* Partner API (`/api/v1`) and factory API (`/api/mes/v1`) with their own guides in `docs/integration/`.

## Requirements

* Node.js 22 or newer and npm (the repository is an npm workspace).
* Docker, for the development database (PostgreSQL 16 on port 5433). ClamAV is optional in development.
* PostgreSQL 16 in production, and ClamAV (clamd over TCP) for malware scanning.
* A modern browser. The web app is SolidJS 1.9 and Vite 6 (see `docs/WEB_SOLIDJS.md`).

## Quick start (development)

Run these from the repository root.

```bash
npm install
npm run db:up                      # PostgreSQL 16 in Docker on port 5433
npm run -w server init-dev         # writes server/.env with fresh random development keys
npm run migrate                    # applies the migrations and creates the restricted kph_app role
npm run seed                       # demo data (wipes the database first, development only)
npm run dev                        # API on http://localhost:4000 (the worker runs inside it)
npm run dev:web                    # web app on http://localhost:5173 (proxies /api to port 4000)
```

Open http://localhost:5173. To serve the built web app from the API instead, run `npm run build` and open http://localhost:4000.

Notes:

* `init-dev` keeps an existing `server/.env` unless you add `--force` (`npm run -w server init-dev -- --force`).
* The seed wipes every table, including the audit log. It refuses to run when `NODE_ENV` is `production`.
* The seed writes a demo factory system key and a demo partner key (for Acme Aligners) to `server/data/demo-keys.txt` (development only, used in `docs/DEMO_SCRIPT.md`).
* The seed also creates about 18 Acme cases in every status with small real encrypted files, two claims, a replacement and a rework, and sample factory events. In demo mode the Direct manufacturing page offers a zip of four fictional sample cases to download.
* Self registration is off in the generated `.env` (`SIGNUP_ENABLED=false`). Set it to `true` and restart to show the registration form.
* Do not start a second API on a port that is already in use.

### Settings for a public tunnel (development)

If you publish the development Hub through a tunnel such as cloudflared, the tunnel connects from this computer, so set these in `server/.env` (they are commented out in the file `init-dev` writes):

| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY` | `false` | Which proxies may tell the Hub the real visitor address. `false`, `true`, a number of hops, or a comma separated list of addresses, CIDR ranges and the names `loopback`, `linklocal`, `uniquelocal`. For cloudflared on this computer use `loopback`; behind the production Caddy use its address (`172.29.10.2`). A wrong value stops the server from starting. Without it every visitor looks like the tunnel and shares one rate limit. |
| `TUNNEL_HOOKS_ONLY` | `false` | When `true`, a request that carries proxy headers (`x-forwarded-for`, `forwarded`, `cf-connecting-ip`, `cf-ray`, `x-real-ip`) is answered `404` unless it is for the portal webhook receiver (`/api/hooks/kline-portal/<id>`) or `/api/health`. The public tunnel then exposes only the webhook receiver. The server refuses to start in production with this on. |
| `DEMO_MODE` | `true` in `init-dev` | Demo accounts, live authenticator codes, the development mailbox. These answer only to direct local use: a request with proxy headers, or from a public address, gets `404`. Production refuses to start with it on. |

### Demo accounts

All demo accounts share one password: `Demo2026PartnerHub`. The sign in page lists the accounts and shows each account's current authenticator code (demo mode only). All addresses end in `.demo`.

| Account | Company | Role |
|---|---|---|
| `admin@acme.demo` | Acme Aligners | admin |
| `upload@acme.demo` | Acme Aligners | uploader |
| `quality@acme.demo` | Acme Aligners | quality |
| `finance@acme.demo` | Acme Aligners | finance |
| `admin@kline.demo` | K Line Europe GmbH | kl_admin |
| `intake@kline.demo` | K Line Europe GmbH | kl_intake |
| `chaves@kline.demo` | K Line Europe GmbH (site PT-CHV only) | kl_production |
| `quality@kline.demo` | K Line Europe GmbH | kl_quality |
| `finance@kline.demo` | K Line Europe GmbH | kl_finance |
| `owner@contoso.demo` | Contoso Smile (registered itself, email confirmed, waiting for review) | admin |

Fabrikam Dental Lab registered but has not confirmed its email address. Its confirmation link is shown on the registration page in demo mode.

## Scripts

| Command | What it does |
|---|---|
| `npm run db:up` / `npm run db:down` | Start or stop the development PostgreSQL container (`deploy/docker-compose.dev.yml`). |
| `npm run -w server init-dev` | Write `server/.env` with fresh development keys. |
| `npm run migrate` | Apply migrations as `kph_owner` and create or update the `kph_app` role. |
| `npm run seed` | `cli seed --force`: wipe and create the demo data. |
| `npm run dev` | API with `tsx watch` and the worker inside the process (`RUN_WORKER=true`). |
| `npm run dev:web` | Vite dev server on port 5173. |
| `npm run build` | Build the web app (`web/dist`), then the server (`server/dist`: `index.js`, `worker.js`, `cli.js`). |
| `npm start` | Run the built API (`node server/dist/index.js`). |
| `npm run typecheck` | Type check server and web. |
| `npm test` | Server tests with vitest against a real PostgreSQL (see below). |

Command line tool (`server/src/cli.ts`). In development run it from `server/` with `npx tsx src/cli.ts <command>`. From a build use `node dist/cli.js <command>`.

| Command | What it does |
|---|---|
| `migrate` | Apply migrations (needs `DATABASE_OWNER_URL`). |
| `seed [--force]` | Demo data. Development only. |
| `create-admin --email E --name N [--google]` | Create a K Line administrator and print a one time invite link (valid 7 days). With `--google` no link is made: the person signs in with Google Workspace (needs `OIDC_ALLOWED_DOMAIN`, and an address in that domain), then sets up the authenticator. |
| `gen-key [--id ID]` | Print a new master key entry for `MASTER_KEYS`. |
| `audit-verify` | Verify the audit log hash chain. Exit code 1 when it is broken. |
| `audit-trim --months N` | Remove audit entries older than N months (default `AUDIT_RETENTION_MONTHS`, 36). |
| `retention` | Run the retention job now. It also runs daily in the worker. |
| `portal-sync` | Read case statuses from the K Line portal now. It also runs every 10 minutes in the worker. |
| `rewrap [--dry-run] [--only KIND[,KIND]] [--batch N]` | Key rotation: move file keys and encrypted fields to the active master key. Kinds: `files`, `patient_names`, `instructions`, `file_names`, `totp`, `webhooks`, `portal_keys`, `blind_index`. See `docs/SECURITY.md` for the procedure. |

## Running the tests

The tests run against a real PostgreSQL with the restricted `kph_app` role, through the HTTP layer.

```bash
npm run db:up
npm run -w server init-dev      # once, so the test database can reuse the app role password
npm test
```

The global setup drops and recreates a database called `kph_test` on `localhost:5433` (override with `KPH_TEST_PG` and `KPH_TEST_OWNER`), applies the migrations and runs the files in `server/test/`. Tests run one file at a time. The web app has a type check (`npm run typecheck`) but no automated browser tests.

## Project layout

```
shared/     Plain TypeScript used by the server and the web app:
            roles.ts stages.ts filenames.ts bulk.ts bag.ts spec.ts defects.ts signup.ts geo.ts
server/
  migrations/   001 to 006 SQL migrations (run as kph_owner)
  scripts/      init-dev.mjs
  src/          index.ts (API) worker.ts cli.ts app.ts config.ts audit.ts jobs.ts handlers.ts
                db/ auth/ crypto/ http/ storage/ routes/ services/ demo/
  test/         unit and integration tests
web/
  src/          main.tsx (routes) lib/ ui/ layout/ viewer/ pages/ (partner, console, auth)
deploy/         docker-compose.dev.yml (development database); docker-compose.prod.yml, Caddyfile, clamd.conf; hetzner/ (guide, env examples, backup and restore test scripts)
Dockerfile      one image for the API, the worker and the CLI
.github/        workflows/ci.yml (checks), dependabot.yml, CODEOWNERS, pull_request_template.md
docs/           BRIEF.md, PHASE2 to PHASE6 contracts, integration guides, this documentation
```

The API serves the built web app with a single page fallback, so one process serves both.

## Production

Production runs one image with three processes: the API (`dist/index.js`), the worker (`dist/worker.js`) and the command line tool (`dist/cli.js`). The API refuses to start when the configuration is unsafe (see `docs/SECURITY.md`, "Production refusals").

Follow `deploy/hetzner/README.md`: server, firewall, encrypted volume, secrets, image build, first start, backups with a monthly restore test, optional Google sign in, upgrades and key rotation. The stack is in `deploy/docker-compose.prod.yml` (Caddy with automatic HTTPS, app, worker, PostgreSQL 16, ClamAV on an internal network). Use `docs/ARCHITECTURE.md` (configuration table) and `docs/SECURITY.md` as the checklist.

## Contributing and repository rules

This is a private repository that holds confidential K Line Europe GmbH software (see `LICENSE`). Keep it private and give access only to named people.

* **Never commit secrets.** No `.env` files (only the `*.env.example` files), keys, certificates, tokens, passwords or database dumps. `.gitignore` blocks the usual ones, and the `secret-scan` check looks for the rest.
* **Never commit real patient data or real case files.** No zip, STL, PTS, DICOM or CSV files from a real case, no screenshots of real cases, and no real patient names or case numbers in tests, documents or comments. Use the fictional demo data (Acme, Contoso, Fabrikam, Marc Alonso and so on). A local `real-samples/` folder is ignored by git for your own testing.
* **Work on branches and open a pull request.** `main` is protected: no direct pushes, at least one approving review, and the `checks`, `docker` and `secret-scan` status checks must pass before merging. See `docs/GITHUB_SETUP.md` for the exact settings.
* **Keep database changes in migrations.** Add a new numbered file in `server/migrations/`. Never edit a migration that has been applied.
* **Run the checks locally before you push**, from the repository root (the database must be running: `npm run db:up`):

```bash
npm run typecheck
npm run test -w server
npm run build
npm audit --audit-level=high
```

The same checks run on every pull request (`.github/workflows/ci.yml`). Setting up the GitHub organisation, the private repository, branch protection and security features is described step by step in `docs/GITHUB_SETUP.md`.

## Documentation index

| Document | For |
|---|---|
| `docs/BRIEF.md` | The engineering brief (working copy) and fixed decisions. |
| `docs/PHASE2_CONTRACT.md` to `docs/PHASE6_CONTRACT.md` | API and behaviour contracts for each build phase. |
| `docs/ARCHITECTURE.md` | Components, data flow, tenancy, queue, storage, lifecycle, configuration. |
| `docs/SECURITY.md` | Security controls mapped to code, known gaps, reporting, penetration test advice. |
| `docs/PARTNER_GUIDE.md` | A friendly guide for partner staff. |
| `docs/DEMO_SCRIPT.md` | A 20 minute walkthrough of every feature. |
| `docs/integration/PARTNER_API.md` | Partner ERP API, webhooks and exports. |
| `docs/integration/MES_INTEGRATION.md` | Factory system (MES) integration. |
| `docs/gdpr/` | Draft GDPR documents for K Line Legal and Compliance: `DPIA.md`, `TOMs.md`, `RECORD_OF_PROCESSING.md`, `RETENTION.md`, `SUBPROCESSORS.md`, `TRANSFERS.md`, `BREACH_RUNBOOK.md`, `PRIVACY_NOTICE_NOTES.md`. |
| `docs/GITHUB_SETUP.md` | Step by step guide for the GitHub organisation, the private repository, branch protection, security features, the first commit and how to read a failed check. |
| `docs/OPEN_DECISIONS.md` | Open decisions and known gaps with owners and next steps. |

The legal and policy documents in `docs/gdpr/` are drafts. They are not legal advice and they do not certify anything. K Line's Legal and Compliance team must review them before use.
