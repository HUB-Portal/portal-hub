# Putting the Portal Hub on GitHub

A step by step guide for the repository owner. It covers the organisation, the private repository, the settings to click, the first commit, what the automatic checks do and how to read a failed check. Do the steps in order. The menu names are those of GitHub in 2026 and can move a little.

The repository holds confidential software and documents. It must stay **private**.

## 1. Create the organisation

1. Sign in to GitHub with your own account. Turn on two factor authentication first (Settings, Password and authentication). Use an authenticator app or a security key, not SMS.
2. Click your picture, then **Your organizations**, then **New organization**.
3. Choose a plan. The Free plan is enough to start, but see the note about branch protection in step 4. The Team plan is the safer choice for a company repository.
4. Name it after the company, for example `k-line-europe`. Use a company email address as the contact.
5. In the organisation, open **Settings**, **Authentication security** and turn on **Require two-factor authentication** for every member.
6. Under **Settings**, **Member privileges**, set **Base permissions** to **No permission**, and untick the options that let members create public repositories or fork private ones.
7. Create a team (for example `portal-hub-maintainers`) under **Teams** and add the people who may review and merge. Use this team name in `.github/CODEOWNERS`.

## 2. Create the private repository

1. In the organisation click **New repository**.
2. Name it `kline-partner-hub` (or similar). Choose **Private**.
3. Do **not** tick "Add a README", "Add .gitignore" or "Choose a license". The project already has them, and an empty repository avoids a merge on the first push.
4. Click **Create repository**. Keep the page open: it shows the address you need in step 6.
5. Open the repository **Settings**, **General**, and under **Features** leave Issues on. Under **Pull Requests** turn on **Allow squash merging**, turn off **Allow merge commits** and **Allow rebase merging** if you want one commit per change, and turn on **Automatically delete head branches**.

## 3. Check the files before the first commit

Run this from the project folder. It starts the repository (an empty one, nothing is stored yet) and lists what Git would add, without adding anything:

```bash
git init -b main
git add -n . | wc -l        # expect about 330 files
git add -n . | grep -iE "\.env|\.zip|\.stl|\.pts|\.dcm|server/data|node_modules|dist/"
git check-ignore -v server/.env server/data
```

The `grep` must print nothing except the `deploy/hetzner/*.env.example` files (examples without real values). If it prints anything else, the file is not ignored: stop and tell the maintainer before you go on. The last command must show that `server/.env` and `server/data` are ignored.

## 4. Branch protection for `main`

Do this right after the first push (step 6), because a branch must exist before it can be protected.

1. In the repository open **Settings**, **Rules**, **Rulesets**, **New ruleset**, **New branch ruleset**. (On older screens: **Settings**, **Branches**, **Add branch protection rule**, branch name pattern `main`.)
2. Name it `protect-main`. Set **Enforcement status** to **Active**. Target the default branch.
3. Tick these rules:
   * **Restrict deletions**
   * **Require linear history**
   * **Require a pull request before merging**, with **Required approvals: 1** (use 2 once the team is larger), **Dismiss stale pull request approvals when new commits are pushed**, **Require review from Code Owners** (after you have filled in `.github/CODEOWNERS`) and **Require approval of the most recent reviewable push**
   * **Require status checks to pass**, with **Require branches to be up to date before merging**, and add the checks `Type check, tests, build, audit`, `Docker image` and `Secret scan` (they appear in the list after the first workflow run)
   * **Block force pushes**
4. Leave the **Bypass list** empty, so that nobody (including you) can skip the rules. Add yourself only if you really need an emergency route, and then use it rarely.
5. Click **Create**.

Note: rulesets and branch protection on private repositories need a paid plan (Team or higher). On the Free plan GitHub does not enforce them for private repositories. If you stay on Free, the rules above are only a habit, so move to Team before real work starts.

## 5. Security features to turn on

In the repository open **Settings**, **Code security** (named "Advanced Security" on some screens). Turn on:

| Feature | Why |
|---|---|
| **Dependency graph** | Lists the libraries used. Needed by the next two. |
| **Dependabot alerts** | Warns about libraries with known security problems. |
| **Dependabot security updates** | Opens pull requests that fix those problems. |
| **Dependabot version updates** | Already configured in `.github/dependabot.yml` (weekly: npm, GitHub Actions, Docker). |
| **Secret scanning** | GitHub's own scan for leaked keys. Turn on **Push protection** too, so a push with a key in it is refused. |
| **Code scanning (CodeQL)**, if your plan offers it | Finds common coding mistakes. Choose the default setup for JavaScript and TypeScript. |
| **Private vulnerability reporting** | Lets people report a problem to you without making it public. |

Also check **Settings**, **Actions**, **General**:

* **Actions permissions**: allow actions created by GitHub and the specific actions the workflow uses (`actions/*`, `docker/*`).
* **Workflow permissions**: **Read repository contents and packages permissions** (the workflow already asks for `contents: read` only).
* **Fork pull request workflows**: **Require approval for all outside collaborators**.

And **Settings**, **Collaborators and teams**: give the maintainers team **Write** (or **Maintain**) and nobody **Admin** except the owner. Never add an outside person without a written reason.

## 6. The first commit and push

From the project folder, in a terminal (you already ran `git init -b main` in step 3):

```bash
git add .
git status --short | head -20      # a last look: no .env, no zip, no STL
git commit -m "Initial commit: Portal Hub"
git remote add origin https://github.com/YOUR-ORG/kline-partner-hub.git
git push -u origin main
```

Replace `YOUR-ORG/kline-partner-hub` with the real organisation and repository name. When Git asks you to sign in, use your GitHub account (the Git Credential Manager opens a browser window). The first push starts the workflows; open the **Actions** tab to watch them.

Windows note: `.gitattributes` makes Git store every text file with LF line endings, so the warnings "CRLF will be replaced by LF" on the first `git add` are normal.

Then continue with step 4 (branch protection). From now on work on a branch and open a pull request:

```bash
git switch -c my-change
# edit, test
git add -A
git commit -m "Describe the change"
git push -u origin my-change
```

Then click **Compare and create pull request** on GitHub and fill in the checklist.

## 7. What must never be committed

* `.env` files and anything like them (`server/.env`, `deploy/.env`, `*.env` with real values). Only the `*.env.example` files with `CHANGE_ME` placeholders belong in the repository.
* Master keys (`MASTER_KEYS`), database passwords, API keys (`kph_...`), webhook secrets (`whsec_...`), SMTP and Google sign in secrets, private keys and certificates (`*.pem`, `*.key`).
* Backups and database dumps (`*.dump`, `*.sql.gz`, `*.age`, `*.bak`).
* Real patient or case files: zip, STL, PTS, DICOM and CSV files from a real case, and anything in `server/data/` or `real-samples/`.
* Real patient names or case numbers in tests, documents, comments, commit messages or screenshots. Use the fictional demo data.
* Log files (`*.log`, `hub.log`), which can contain addresses and identifiers.

If something like this is committed by mistake: do not just delete it in a new commit, because it stays in the history. Tell the maintainer at once. Rotate (replace) every secret that was exposed, and ask for the history to be cleaned before anyone else clones the repository.

Documents to confirm before the first push: `docs/KLINE-API-2.6.txt` is the K Line customer portal API document supplied by the owner. It holds only placeholder values, but it is a partner document. Confirm that K Line is happy for it to live in this private repository, or remove it and add `docs/KLINE-API-2.6.txt` to `.gitignore`.

## 8. What each workflow does

All workflows are in `.github/workflows/`. The file `ci.yml` is named **checks** and runs on every pull request and on every push to `main`. A newer run on the same branch cancels an older one.

| Job | What it does | Fails when |
|---|---|---|
| **Type check, tests, build, audit** (`checks`) | Starts a throw away PostgreSQL 16 on port 5433, installs the dependencies with `npm ci`, writes a development `.env` with `npm run init-dev -w server`, then runs `npm run typecheck`, `npm run test -w server` (about 830 tests against the real database), `npm run build` and `npm audit --audit-level=high`. | A type error, a failing test, a build error, or a library with a known high or critical vulnerability. |
| **Docker image** (`docker`) | Builds the production image without pushing it, then starts it with unsafe settings (`NODE_ENV=production` and an `http://` public address) and checks that it refuses with the message "PUBLIC_URL must be https in production". | The image does not build, or it starts when it should refuse. |
| **Secret scan** (`secret-scan`) | Runs gitleaks over the whole history, using the rules in `.gitleaks.toml`. | A password, key or token is found. |

`.gitleaks.toml` keeps all the default rules and allows only the documented demo values (the shared demo password, the placeholder keys in the API guides and a few made up test passwords). Do not add broad allowances. If a new test needs a made up password, add that exact value to the allowlist, or build it in code (for example `'A'.repeat(43)`).

Dependabot opens weekly pull requests for npm libraries, GitHub Actions and the Docker base image. Read each one, check that the `checks` pass, and merge it.

## 9. How to read a failed check

1. On the pull request scroll to **Checks**. A red cross marks the job that failed. Click **Details**.
2. The job page lists the steps. The failed step is open and red. Read the last 30 lines of it: the error is almost always there.
3. Typical causes:
   * **Type check**: a line such as `src/x.ts(12,5): error TS2322`. Run `npm run typecheck` on your computer and fix that line.
   * **Tests**: a line starting with `FAIL` and the test name, then the expected and the received value. Run `npm run test -w server` locally (with `npm run db:up` first). If the test passes on your computer but fails on GitHub, look for a dependency on your local `server/.env`, on the order of tests, or on the time of day.
   * **Build**: an error from `esbuild` or `vite`. Run `npm run build` locally.
   * **Audit**: the list shows the library and a fix. Run `npm audit` locally, then `npm audit fix` or update that library. If there is no fix yet, tell the maintainer before you decide anything.
   * **Docker image**: look at the step that failed. A build error usually means a file the Dockerfile needs is missing from the repository or excluded by `.dockerignore`. The smoke step prints the container output; check that the message "PUBLIC_URL must be https in production" is still produced by `server/src/config.ts`.
   * **Secret scan**: the output names the file, the line and the rule. If it is a real secret, treat it as leaked: replace the secret everywhere, then remove it from the history (see step 7). If it is a made up test value, add that exact value to `.gitleaks.toml`.
4. Fix the problem, commit and push to the same branch. The checks run again by themselves. **Re-run all jobs** (top right of the job page) repeats a run without a new commit, which is useful for a one off network problem.
5. Never turn a check off or add yourself to the bypass list to get a change through.

## 10. Secrets for later deployment

The workflows need no secrets today. When automatic deployment is added later, store the values in **Settings**, **Secrets and variables**, **Actions**, never in a file.

* Prefer **environment secrets**: create an environment called `production` (**Settings**, **Environments**), add **Required reviewers** and restrict it to the `main` branch. A deploy job then waits for an approval before it can read the secrets.
* Likely secrets: the SSH private key of a dedicated deploy user and the server address (`DEPLOY_SSH_KEY`, `DEPLOY_HOST`), and a registry token if the image is pushed to a registry. Use a key made only for this purpose, with the fewest rights possible.
* The application's own secrets (`MASTER_KEYS`, database passwords, SMTP and Google sign in) stay on the server in `/srv/kph/secrets/` as described in `deploy/hetzner/README.md`. They do not go into GitHub at all.
* To let the server pull the code, add a **deploy key** with read only access (**Settings**, **Deploy keys**) instead of using a personal account.
* Rotate any secret that was ever shown in a log or shared by chat.
