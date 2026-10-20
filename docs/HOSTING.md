# Hosting the Vobiz MCP connector

The hosted connector (`dist/hosted.js`, Docker image `ghcr.io/vobiz-ai/vobiz-mcp`) is a stateless, multi-tenant MCP server over Streamable HTTP, with a built-in OAuth 2.1 authorization server. Every user signs in with their own Vobiz Auth ID and Auth Token. The server stores no credentials: they are sealed (AES-256-GCM) inside the tokens it issues.

## Requirements

| Item | Value |
|---|---|
| Public URL | An https origin, e.g. `https://mcp.vobiz.ai`. The MCP endpoint is `<origin>/mcp`. |
| TLS | Terminated at your load balancer or ingress. The app listens on plain HTTP (`PORT`, default 3000). |
| Secret | `VOBIZ_HOSTED_SECRET`: at least 32 random characters, the same on every replica, and stable across deploys. Rotating it signs every user out. |
| Egress | `https://api.vobiz.ai` (or `VOBIZ_BASE_URL`), plus `https://claude.ai` and `https://chatgpt.com` for Client ID Metadata Documents |
| Ingress | If you filter by IP, allow Anthropic's published egress ranges so Claude can reach the connector. |

## Run

```bash
docker run -d --name vobiz-mcp -p 3000:3000 \
  -e VOBIZ_HOSTED_URL=https://mcp.vobiz.ai \
  -e VOBIZ_HOSTED_SECRET="$(openssl rand -hex 32)" \
  -e VOBIZ_ENABLE_CALLS=true -e VOBIZ_ENABLE_MESSAGING=true \
  ghcr.io/vobiz-ai/vobiz-mcp:latest
```

Without Docker: `npm ci && npm run build && VOBIZ_HOSTED_URL=… VOBIZ_HOSTED_SECRET=… node dist/hosted.js`.

[`.env.example`](../.env.example) lists every other setting: limits, countries, links, token lifetimes and excluded tools. Calling and messaging stay off unless you enable them. Even when enabled, every call and message needs the user's confirmation and must pass the server's caps.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (stateless; `Authorization: Bearer` required) |
| `GET /.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414), with PKCE S256, DCR and CIMD |
| `GET /authorize` | Sign-in and consent page |
| `POST /oauth/login` | Consent form submission (checks the credentials with Vobiz) |
| `POST /token`, `POST /register`, `POST /revoke` | OAuth token, dynamic client registration, revocation |
| `GET`/`POST /answer` | Default answer XML for `make_call` |
| `POST /jobs/fire` | Reminder-call job delivery from Cloud Tasks (body: sealed job token) |
| `POST /r/:token/answer`, `/r/:token/input`, `/r/:token/hangup` | Vobiz callbacks for a reminder call (sealed per-call token) |
| `GET /.well-known/openai-apps-challenge` | OpenAI Apps domain verification (`VOBIZ_OPENAI_APPS_CHALLENGE`; 404 when unset) |
| `GET /health` | Liveness (`{"ok":true,"version":"…"}`) |

## Verify a deployment

```bash
curl -s https://mcp.vobiz.ai/health
curl -s https://mcp.vobiz.ai/.well-known/oauth-protected-resource/mcp   # resource must equal https://mcp.vobiz.ai/mcp
curl -si -X POST https://mcp.vobiz.ai/mcp | grep -i www-authenticate     # 401 with resource_metadata=
npx @modelcontextprotocol/inspector                                       # connect to https://mcp.vobiz.ai/mcp, sign in, run each tool
```

Then add it in Claude: go to **Settings → Connectors → Add custom connector** and enter `https://mcp.vobiz.ai/mcp`. Sign in, then run the example prompts in [PUBLISHING.md](PUBLISHING.md).

## Sign-in scopes

The consent page asks for the Auth ID and Auth Token, then one of three scopes:

| Scope | Tools offered |
|---|---|
| **Full access** (default) | Every tool, reminder tools included. Writes still need the user's confirmation. |
| **Personal assistant** | Only `schedule_reminder_call`, `list_reminder_calls`, `get_reminder_call`, `cancel_reminder_call`, `get_account_balance`, `list_phone_numbers` and `get_call_status`. Reminder calls always go to the user's own number. |
| **Read-only** | Read-only tools only. |

For full access and personal assistant the page also asks for **Call me on** (the user's number, E.164, required for personal assistant), **Call from** (optional caller ID on the account; blank = the first voice number) and **Timezone** (IANA, default `Asia/Kolkata`). They are sealed into the tokens with the credentials.

## Reminder calls

A user says "wake me up at 6 tomorrow" or "call me at 3 to remind me about X". The client calls `schedule_reminder_call` once. From then on the connector does everything itself:

1. It stores the reminder (no credentials) and queues a job for the call time.
2. At that time the job hits `POST /jobs/fire`, and the connector places the call from the user's Vobiz number.
3. When the call is answered, Vobiz fetches `/r/:token/answer`. The call speaks the message and offers **1** to snooze, **2** to confirm and **9** to stop.
4. On no answer, busy, voicemail or no key press, it retries after `retry_minutes`, up to `max_attempts`.

Credentials never reach the store. They travel only inside sealed job and per-call tokens, so `VOBIZ_HOSTED_SECRET` must be the same on every replica and stable across deploys: rotating it invalidates every pending reminder.

| Setting | Default | Purpose |
|---|---|---|
| `VOBIZ_REMINDERS` | `true` | Offer reminder calls. Calling must also be on (`VOBIZ_ENABLE_CALLS=true`). |
| `VOBIZ_GCP_PROJECT`, `VOBIZ_TASKS_LOCATION`, `VOBIZ_TASKS_QUEUE` | unset | Set all three for the Cloud Tasks + Firestore backend. |
| `VOBIZ_FIRESTORE_DATABASE` | `(default)` | Firestore database id. |
| `VOBIZ_FIRESTORE_COLLECTION` | `reminders` | Collection holding reminder records. |
| `VOBIZ_MAX_ACTIVE_REMINDERS` | `20` | Active reminders per account. |
| `VOBIZ_MAX_REMINDER_CALLS_PER_DAY` | `10` | Reminder call attempts per destination per UTC day. |

Reminders can be scheduled at most 30 days ahead (the Cloud Tasks limit).

**GCP resources (production).**

- A Cloud Tasks queue in `VOBIZ_TASKS_LOCATION` (for example `gcloud tasks queues create vobiz-reminders --location=asia-south1`). Tasks are HTTP tasks to `<VOBIZ_HOSTED_URL>/jobs/fire`; the job body is a sealed token, so the endpoint needs no OIDC token.
- Firestore in Native mode (the `(default)` database or the one in `VOBIZ_FIRESTORE_DATABASE`).
- The Cloud Run service account needs `roles/cloudtasks.enqueuer` and `roles/cloudtasks.taskDeleter` on the queue (or `roles/cloudtasks.admin` on the project) and `roles/datastore.user`.

**Memory fallback.** Without the three Cloud Tasks variables, reminders are kept in memory and fired with timers. This is for local development and single-replica tests only: run exactly one replica, and expect every scheduled reminder to be lost on restart or scale-down. The connector logs a warning at startup in this mode.

## Scaling and operations

- **Stateless.** Any replica can serve any request, so run two or more behind a load balancer.
- **Per-replica state.** Rate-limit counters, idempotency records and used-code tracking live in memory on each replica. They protect each process; Vobiz's own CPS limits still apply across the account.
- **Logs.** Logs go to stderr and contain route templates, status codes and timings only. Tokens, message text and phone numbers are never logged.
- **Revocation.** A user revokes access by rotating their Auth Token in the console, which invalidates all of that account's tokens immediately. The operator revokes everyone at once by rotating `VOBIZ_HOSTED_SECRET`.
