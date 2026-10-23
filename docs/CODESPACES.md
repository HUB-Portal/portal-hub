# Temporary demo on GitHub (Codespaces)

A Codespace is a temporary cloud computer that GitHub runs for you. The repository's `.devcontainer/` folder makes it start the real Portal Hub with the fictional demo data. Nothing here is a production setup: no real data, no real keys, no scanner, no real mail.

## Start it

1. Open the repository on GitHub, click **Code**, **Codespaces**, **Create codespace on main**.
2. Wait about five minutes the first time. It installs the packages, starts PostgreSQL in Docker, creates the demo data and builds the app. You can watch it in the terminal ("Creating codespace").
3. When the **Ports** tab shows port **4000** (Portal Hub), click the globe icon next to it. The Hub opens in a new browser tab.
4. The sign in page cannot list the demo accounts through the forwarded address (the Hub hides them from any request that came through a proxy, on purpose). Print them in the terminal instead:

```bash
npm run -w server demo-accounts
```

It shows every demo account, the shared demo password and each account's current authenticator code. The code changes every 30 seconds, so run the command again if it has expired. Example accounts: `admin@acme.demo` (partner) and `admin@kline.demo` (K Line console).

## Keep it private

* The port is **Private**: only you, signed in to GitHub, can open it. Do not change it to **Public** and do not send the link to other people. Anyone who has the link could use the demo accounts.
* To show it to someone, share your screen, or add them as a collaborator on the repository and let them create their own Codespace.

## Stop it and the cost

* A Codespace stops by itself after 30 minutes without activity. Its data (the demo database) stays until you delete it. When you open it again the app starts by itself.
* Free personal accounts get a monthly allowance of core hours and storage. When you are done, delete the Codespace at https://github.com/codespaces to stop using the allowance.
* To reset the demo data: `npm run seed`.

## What does not work here

* Email is not sent (the demo shows messages in the development mailbox, which is hidden behind the forwarded address too).
* Malware scanning is off (`SCANNER=none`), as in the normal development setup.
* The sample cases zip on the Direct manufacturing page is a demo helper and is also hidden behind the forwarded address. Use the files under `docs/` or your own test files.
