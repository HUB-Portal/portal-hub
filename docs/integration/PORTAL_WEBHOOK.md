# K Line portal webhook (instant updates)

## 1. What it is

The Hub already checks the K Line customer portal every 10 minutes for the status of the direct manufacturing cases it has sent (see `docs/ARCHITECTURE.md`, "Portal status sync"). The portal can also tell the Hub straight away when a case changes. That is a webhook: the portal sends a short HTTP request to an address that belongs to your company in the Hub.

The Hub treats that request as a **reminder only**. It never reads a status out of it. When a request about one of your cases arrives, the Hub queues a normal status check for that case, which asks the portal API for the real status using your company's own portal credentials. A forged or replayed message therefore cannot change a case. At worst it causes one extra status check.

The 10 minute check stays on as a backup, so a lost message only delays an update, it never loses one.

What the portal sends (from the K Line API 2.6, section "Webhooks"):

* Method `POST`, `Content-Type: application/json`, header `X-KLINE-SECRET-TOKEN` with the secret you configured.
* Body `{ "event": "insert" | "update", "type": "case" | "treatment_plan" | "doctor" | "comment", "uuid": "...", "data": { ... } }`.
* For `case` the `data` holds the Retrieve Case fields, including patient names. Comments carry the author, `case_id`, `case_uuid` and the comment text.

The Hub reads only `type` and `uuid` from the body. Everything else is dropped without being stored, logged or echoed. See section 5.

## 2. Setting it up

You need the permission `integration.manage` (company administrators have it), an approved company, your portal connection saved under **Portal connection**, and an address for the Hub that the portal can reach over https (section 4).

In the Hub:

1. Open **Portal connection**. Find the card **Instant updates from the K Line portal**.
2. Press **Create address and secret** and enter your authenticator code.
3. Copy the address and the secret from the dialog. The secret is shown **once**. The Hub keeps it encrypted and cannot show it again.

In the K Line portal:

1. Open your avatar menu, then **API Webhooks**, then **Add Webhook**.
2. Give it a label, for example "Portal Hub".
3. Paste the address as the **URL**.
4. Paste the secret as the **Secret Token**.
5. Choose the **Case** triggers (insert and update). The other triggers are accepted but ignored.
6. Make sure **Enabled** is on (the portal allows up to 5 enabled webhooks) and save.
7. Press **Test** in the portal. The Hub answers with 200. The card in the Hub now shows the time of the last message and the number of messages received. A test message is counted as "needed no action".

To change the secret, press **Make a new secret** in the Hub (the old secret stops working at once, the address stays the same) and paste the new secret into the portal. To stop instant updates, press **Remove the address** and delete the webhook in the portal.

## 3. API

All three are session only, need `integration.manage`, and need an approved partner company (reading is allowed before approval). Changes need a recent authenticator code (`403 step_up_required` otherwise) and are audited without the secret.

| Route | What it does |
| --- | --- |
| `GET /api/org/portal-api` | The portal connection, plus `webhook: { configured, url, lastReceivedAt, receivedCount, lastResult, publicUrlWarning, createdAt, rotatedAt }`. `url` is `PUBLIC_URL` plus `/api/hooks/kline-portal/<hookId>`. `lastResult` is `ok`, `ignored` or `bad_secret`. `publicUrlWarning` is true when `PUBLIC_URL` is not https or is localhost or a private address. The secret is never returned. |
| `POST /api/org/portal-api/webhook` | Creates the receiver (201) or rotates its secret (200). Returns `{ url, secret, rotated }`. The secret is shown only in this answer. |
| `DELETE /api/org/portal-api/webhook` | Removes the receiver. The address answers 404 afterwards. |

The public receiver:

| Route | Answers |
| --- | --- |
| `POST /api/hooks/kline-portal/:hookId` | `404 {code:'not_found'}` for an unknown address. `401 {code:'unauthorised'}` for a missing or wrong `X-KLINE-SECRET-TOKEN`. `200 {ok:true}` for every message with the right secret, whether or not anything was done. `413` over 256 KB. `429` over the limits. |

## 4. Testing on your own computer (tunnel)

The portal needs an https address that it can reach from the internet. `http://localhost:4000` cannot be reached from outside, so use a tunnel. The Hub warns on the card (`publicUrlWarning`) until `PUBLIC_URL` is a public https address.

Start the Hub as usual, then in a second terminal start one tunnel that points at the Hub's port (4000 by default):

```
# Cloudflare (no account needed for a quick tunnel)
cloudflared tunnel --url http://localhost:4000

# or ngrok (needs a free account and `ngrok config add-authtoken ...` once)
ngrok http 4000
```

Both print an address like `https://random-words.trycloudflare.com` or `https://1234abcd.ngrok-free.app`. Set it in `server/.env` and restart the Hub:

```
PUBLIC_URL=https://random-words.trycloudflare.com
```

Then create (or rotate) the address in the Hub: the URL shown now starts with the tunnel address. Paste it into the portal as described in section 2 and press Test.

Also add these two lines to `server/.env` before you open the tunnel, so that only the webhook receiver is public (the tunnel connects from your own computer, so without them the whole Hub, including the sign in page, is reachable from the internet):

```
TRUST_PROXY=loopback
TUNNEL_HOOKS_ONLY=true
```

With `TUNNEL_HOOKS_ONLY=true` a request that arrives through the tunnel (it carries `cf-connecting-ip`, `x-forwarded-for` and similar headers) is answered `404` unless it is for `/api/hooks/kline-portal/<id>` or `/api/health`. You still use the Hub yourself at `http://localhost:4000`. The demo accounts and live codes also answer only to requests that did not come through the tunnel. The setting is refused in production.

Notes:

* Quick tunnels get a new address every time they start. Update `PUBLIC_URL`, restart the Hub, and then the URL in the portal.
* `PUBLIC_URL` also appears in the links in emails, so change it back when you stop the tunnel.
* Without the portal you can try the receiver by hand: `curl -X POST "$URL" -H "Content-Type: application/json" -H "X-KLINE-SECRET-TOKEN: $SECRET" -d '{"event":"update","type":"comment","uuid":"x"}'` answers `{"ok":true}`. Do not paste real patient data into test messages.
* The Hub must also be able to reach the portal API (the credentials on the same settings page) for the status check that follows a message.

## 5. Security design

* **Identity.** Each partner company has at most one receiver in the table `portal_hooks`: a public `hook_id` (24 random bytes, base64url, unique) and a secret token `whsec_...` (32 random bytes). The secret is stored as a field encrypted value (AAD `org|<org id>|portal_hook`) and is shown once. The table has row level security like every tenant table, and the `portal_keys` kind of `cli rewrap` re-wraps these secrets together with the portal API keys.
* **Authentication.** The only credential is the secret token. The Hub hashes both values with SHA-256 and compares the digests in constant time, so neither the content nor the length of the secret leaks through timing. A wrong or missing token gets one generic 401. No session is read and no CSRF token is needed for this route (it is on the CSRF exempt list), so cookies sent along are ignored.
* **Untrusted payload.** The body is read as raw bytes (limit 256 KB) and parsed defensively. Only `type` and `uuid` are looked at. The message is never logged, stored or echoed: not in the request log (which records only method, address with the hook id hidden, and status), not in jobs, case events, notifications, the audit log, the `portal_hooks` row or error messages. Headers other than the secret check are not looked at.
* **Only own cases.** A `case` message is acted on only when its `uuid` matches `cases.portal_case_uuid` of **that** company's own still open direct case. The lookup runs with the company's own row level security context. For a case of another company, a case that does not exist, a finished case, or any other message type (comment, doctor, treatment plan, test), the answer is the same `200 {ok:true}` and nothing is done, so the receiver does not reveal whether a case exists. A company that is not active is treated the same way.
* **No trust in the content.** The queued job `portal.sync.case` carries only the case id. It calls the same function as the Refresh button and the 10 minute check (`runPortalSync({ caseId })`), which reads the real status from the portal with the company's own credentials. If that fails, the job is retried with the normal backoff (30 seconds, doubling, up to 6 attempts) and the case shows the usual fixed error text.
* **Coalescing.** A burst of messages for one case queues one job. While a job for the case is queued or running, no second one is queued. A queued job that is waiting for a retry is brought forward. A lock per case makes simultaneous messages safe.
* **Limits.** 120 requests a minute per IP address (route limit) and 600 a minute per receiver, both answered with 429. A message arrives, is checked and answered in a few database queries, and the status check happens later in the worker.
* **Counters and audit.** The receiver row keeps `last_received_at`, `received_count` and `last_result` (`ok`, `ignored`, `bad_secret`), plus a count of wrong secret attempts. The audit log records create, rotate and delete (never the secret) and wrong secret attempts at most once a minute per receiver, with a counter only.
* **Rotation.** Rotating replaces the stored secret in one transaction: the old secret stops working at once. The address stays the same.

Known limits: the per receiver traffic limit is counted in each server process separately. A message that arrives in the short moment after a running status check has already read the portal is covered by the next 10 minute check, not by a second job.

## 6. Troubleshooting

| What you see | Likely cause and fix |
| --- | --- |
| Card says "The portal cannot reach this Hub address yet" | `PUBLIC_URL` is not https or is a local or private address. Use a tunnel (section 4) or, in production, your real https address. |
| Portal Test shows an error or time out | The address is not reachable from the internet (tunnel stopped, `PUBLIC_URL` changed, firewall), or the URL pasted into the portal is not the one shown in the Hub. |
| Portal Test shows 401 | The Secret Token in the portal differs from the Hub's. Make a new secret in the Hub and paste it into the portal. The card then shows "wrong secret" until a message arrives with the right one. |
| Portal Test shows 404 | The address was removed or mistyped. Check the URL against the card, or create the address again. |
| Messages arrive (count goes up) but cases do not change | The message was about a case that is not open, belongs to another company, or the portal has not changed its status yet. Check the case page and press Refresh. Check **Portal connection** (the Test connection button) because the status check needs working credentials. A failing check shows a fixed error text on the case and is retried. |
| The card shows nothing received but the portal says delivered | The portal may use a different Hub address, such as an old tunnel. Compare the URL. |
| Rate limit (429) | More than 120 requests a minute from one address or 600 for the receiver. The portal retries. |
| Updates still take up to 10 minutes | Normal when no message arrived. The Hub keeps checking as a backup. |

Operators can follow the worker log for the job kind `portal.sync.case`, and the audit log for `portal_hook.created`, `portal_hook.rotated`, `portal_hook.deleted` and `portal_hook.bad_secret`.
