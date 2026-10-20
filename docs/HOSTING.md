# Hosting the Vobiz MCP connector

The hosted connector (`dist/hosted.js`, Docker image `ghcr.io/vobiz-ai/vobiz-mcp`) is a stateless, multi-tenant MCP server over Streamable HTTP, with a built-in OAuth 2.1 authorization server. Every user signs in with their own Vobiz Auth ID and Auth Token. The server stores no credentials: they are sealed (AES-256-GCM) inside the tokens it issues.

## Requirements

| Item | Value |
|---|---|
| Public URL | An https origin, e.g. `https://mcp.vobiz.ai`. The MCP endpoint is `<origin>/mcp`. |
| TLS | Terminated at your load balancer or ingress. The app listens on plain HTTP (`PORT`, default 3000). |
| Secret | `VOBIZ_HOSTED_SECRET`: at least 32 random characters, the same on every replica, and stable across deploys. Rotating it signs every user out. |
| Egress | `https://api.vobiz.ai` (or `VOBIZ_BASE_URL`), plus `https://claude.ai` and `https://chatgpt.com` for Client ID Metadata Documents, and the host of `VOBIZ_TRUSTED_EGRESS_URL` if you set one |
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
| `POST /token`, `POST /register` | OAuth token (code exchange and refresh-token rotation) and dynamic client registration |
| `POST /revoke` | Token revocation (RFC 7009): revoking an access or refresh token ends that whole sign-in |
| `GET /favicon.svg`, `GET /favicon.ico` | The Vobiz logomark for the sign-in and upload pages (`.ico` redirects to `.svg`) |
| `GET`/`POST /answer` | Default answer XML for `make_call` |
| `POST /jobs/fire` | Reminder-call job delivery from Cloud Tasks (body: sealed job token) |
| `POST /r/:token/answer`, `/r/:token/input`, `/r/:token/hangup` | Vobiz callbacks for a reminder call (sealed per-call token) |
| `GET`/`PUT /upload/:token` | Audio upload page, and the raw upload it sends (sealed one-time link, 15 minutes) |
| `GET`/`HEAD /media/:token` | A library file as WAV, fetched by Vobiz for `<Play>` on a reminder call (sealed link, 2 hours) |
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
| **Full access** (default for verified clients) | Every tool, reminder tools included. Writes still need the user's confirmation. |
| **Personal assistant** | Only `schedule_reminder_call`, `list_reminder_calls`, `get_reminder_call`, `cancel_reminder_call`, `get_account_balance`, `list_phone_numbers`, `get_call_status` and the audio library tools (`create_audio_upload_link`, `import_audio_from_url`, `list_audio`, `delete_audio`). Reminder calls always go to the user's own number. |
| **Read-only** (default for local and unverified clients) | Read-only tools only. |

For full access and personal assistant the page also asks for **Call me on** (the user's number, E.164, required for personal assistant), **Call from** (optional caller ID on the account; blank = the first voice number) and **Timezone** (IANA, default `Asia/Kolkata`). They are sealed into the tokens with the credentials.

## OAuth clients and the consent page

The consent page tells the user who is asking. Every client is classified when it opens `/authorize`:

| Kind | Which clients | What the page shows |
|---|---|---|
| **Verified** | Client ID Metadata Document URLs of Claude (`https://claude.ai/oauth/mcp-oauth-client-metadata`), Claude Code (`https://claude.ai/oauth/claude-code-client-metadata`), ChatGPT (`https://chatgpt.com/oauth/client.json` or `/oauth/<id>/client.json`) and Codex (`https://chatgpt.com/oauth/codex/client.json` or `/oauth/codex/<id>/client.json`). Dynamically registered clients whose redirect URIs are all `https://claude.ai/api/mcp/auth_callback` (Claude) or all ChatGPT connector callbacks (ChatGPT). Dynamically registered clients whose redirect URIs are all https on a host in `VOBIZ_TRUSTED_CLIENTS`. | "**Claude** wants to use your Vobiz account." with a name Vobiz fixes (never the client's own `client_name`) and the redirect host in small text. Full access is preselected. |
| **Local** | Every redirect URI is loopback: `http://localhost`, `127.0.0.1` or `[::1]`, any port. | "**Name** on this computer wants to use your Vobiz account." plus the callback host and port and "Only continue if you started it yourself." Read-only is preselected. |
| **Unverified** | Everything else. | An amber **Unverified app** banner with the full redirect URL, the app's name, and how to get verified. Read-only is preselected. |

Names that a client chooses for itself are shown only for local and unverified clients. They are cleaned first: control, format and bidirectional-override characters are removed, whitespace is collapsed, the name is cut to 64 characters, and any name containing Claude, Anthropic, ChatGPT, OpenAI, Codex or Vobiz becomes "An MCP client". Names are always rendered inside `<bdi>`.

Any other https `client_id` (a Client ID Metadata Document from another host or path) is refused.

**Getting a third-party client verified.** A developer emails support@vobiz.ai with the app name and its redirect URL. The operator adds the redirect host to `VOBIZ_TRUSTED_CLIENTS`, for example `VOBIZ_TRUSTED_CLIENTS=app.example.com=Example App,tools.acme.io=Acme Tools`. From the next deploy, dynamically registered clients whose redirect URIs are all https on that host show as **Example App** without the warning. `claude.ai` and `chatgpt.com` cannot be listed (they are verified already).

**Registration rules.** `POST /register` accepts only https redirect URIs, or http on `localhost`, `127.0.0.1` and `[::1]` (any port, per RFC 8252). A redirect URI with a fragment, a `*`, embedded credentials or a private-use scheme (`myapp://callback`) is refused with `invalid_client_metadata`. No supported client uses private-use schemes; a support ticket can request one. `client_name` is cut to 256 characters.

**Authorization errors.** `/authorize` checks `response_type=code`, a PKCE `code_challenge` with `code_challenge_method=S256`, and `resource`. A `resource` must be `<VOBIZ_HOSTED_URL>/mcp` or the bare origin (RFC 8707), otherwise the error is `invalid_target`; a missing `resource` is accepted and means this server. For verified clients an error goes back to the redirect URI with `error`, `error_description`, `state` and `iss` (RFC 9207). Local and unverified clients get a plain error page instead, so `/authorize` cannot be used as an open redirector. Success redirects always carry `iss`.

**Sign-in protection (`POST /oauth/login`).**

- Only a 2xx from Vobiz signs a user in. `401`, `403` and `404` mean the credentials were not accepted; `429` and every other status ask the user to try again.
- At most `VOBIZ_LOGIN_MAX_PER_IP` (10) attempts per client IP and `VOBIZ_LOGIN_MAX_PER_AUTH_ID` (10) per submitted Auth ID in 15 minutes, then `429`.
- At most 5 failed credential attempts per sign-in page; the user then goes back to their app and starts again.
- The form must come from the consent page itself: `Sec-Fetch-Site` must be `same-origin` (or absent on old browsers) and `Origin`, when sent, must be the connector's own origin.

These counters live in each replica's memory, so with N replicas the effective limit is up to N times higher.

**Shared client egress.** Claude's and ChatGPT's backends call `/token` and `/register` for all of their users from a few shared IPs, so the per-IP limits on those two endpoints (50 per 15 minutes on `/token`, 20 per hour on `/register`) would lock every user of that client out at scale. Requests from `VOBIZ_TRUSTED_EGRESS_CIDRS` skip those two limits. `/authorize` and `/oauth/login` keep theirs, because those requests come from the user's own browser.

| Setting | Default | Purpose |
|---|---|---|
| `VOBIZ_TRUSTED_EGRESS_CIDRS` | Anthropic's ranges: `160.79.104.0/21` plus `34.162.102.82/32`, `34.162.136.91/32`, `34.162.142.92/32`, `34.162.183.95/32`, `34.162.46.92/32` ([source](https://platform.claude.com/docs/en/api/ip-addresses)) | Comma-separated IPv4/IPv6 CIDRs. Setting it replaces the defaults, so keep Anthropic's ranges in the list; an empty value trusts none. |
| `VOBIZ_TRUSTED_EGRESS_URL` | unset | An https range list fetched once at startup (64 KB cap, 5 second timeout) and added to the list above, for example OpenAI's ChatGPT connector egress list `https://openai.com/chatgpt-connectors.json`. Any CIDR strings in the JSON (or plain text) are used. On failure the connector logs a warning and keeps the configured ranges. |

OpenAI publishes too many ranges to hard-code. Either set `VOBIZ_TRUSTED_EGRESS_URL` to its list or paste the list into `VOBIZ_TRUSTED_EGRESS_CIDRS` together with Anthropic's ranges.

## Sessions, refresh tokens and revocation

Each sign-in is a session: a refresh-token family in the grant store. The store holds no credentials, only ids, timestamps and a hash of the Auth ID.

- **Rotation with reuse detection.** Every refresh returns a new refresh token and retires the old one (OAuth 2.1 section 4.3.1). For 60 seconds after a rotation, the previous refresh token still works and returns the current tokens again, because Claude refreshes ahead of expiry and replicas can race. Any older refresh token is a replay: the whole session is revoked, its access tokens included.
- **Re-check on refresh.** Every refresh re-checks the sealed credentials with Vobiz. If Vobiz refuses them (for example after the Auth Token was rotated in the console), the session ends. If Vobiz cannot be reached (network error, `429` or `5xx`), one refresh is allowed and logged, and the next one fails with a server error until Vobiz answers again.
- **Absolute lifetime.** A session lasts at most 90 days, however often it is refreshed. Refresh tokens never outlive their session. Access tokens last `VOBIZ_ACCESS_TOKEN_TTL_SEC` (default 3600, at most 86400).
- **Revocation.** `POST /revoke` with an access or refresh token ends its session. Revoked access tokens stop working within 30 seconds on every replica (immediately on the one that handled the revocation).
- **Single-use codes.** Each authorization code can be redeemed once across all replicas.
- **Tokens from before sessions existed** are moved into a session on their first refresh.

**Grant store.** When `VOBIZ_GCP_PROJECT` is set (the same Firestore database as reminder calls, `VOBIZ_FIRESTORE_DATABASE`), sessions are kept in the collection `oauth_grants` (document id = session id; fields `authIdHash`, `clientId`, `currentJti`, `prevJti`, `rotatedAt`, `createdAt`, `revokedAt`) and used codes in `oauth_codes`. Both have an `expireAt` timestamp: add a Firestore TTL policy on `expireAt` for each collection to clean them up. Without a GCP project the store is in memory: run a single replica only, and expect every user to sign in again after a restart. The connector logs which store it uses at startup.

**Response headers.** Every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The consent page uses `Referrer-Policy: same-origin` so that its form post keeps the `Origin` header. The protected resource metadata lists `bearer_methods_supported: ["header"]`.

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

### Audio library

Users can play their own audio (an alarm sound, a recorded message) at the start of a reminder call, before the spoken message. Files land in one private library per account, three ways:

1. `create_audio_upload_link` returns a one-time link to `/upload/:token`. The page takes a file (pick or drop) or records from the microphone, up to 5 minutes.
2. The same link accepts a direct `PUT` with the raw file and an `X-Audio-Name` header (or `?name=`). Claude's code sandbox and similar tools use this when the user attached the file in the chat.
3. `import_audio_from_url` downloads a public https link (private and loopback hosts are refused, size-capped, at most 3 redirects).

Every file is checked and converted with ffmpeg to 8 kHz mono 16-bit WAV, loudness-normalised, with leading silence trimmed. `schedule_reminder_call` takes the file's name as `audio`. When the call is answered, the connector hands Vobiz a fresh `/media/:token` link (valid 2 hours) for `<Play>`, so files are never public. A file deleted after scheduling is skipped: the call still speaks its message.

**ffmpeg.** The Docker image includes `ffmpeg` and `ffprobe`. Elsewhere, install them on `PATH` or point `VOBIZ_FFMPEG` / `VOBIZ_FFPROBE` at the binaries. Without them the connector starts, logs a warning, and refuses uploads and imports with a clear message; reminder calls with `audio_url` keep working.

**Storage.** Set `VOBIZ_MEDIA_BUCKET` to a private Google Cloud Storage bucket for production (every replica sees the same files). Grant the Cloud Run service account `roles/storage.objectAdmin` on the bucket, and keep public access prevention on. Files live under `accounts/<hash of the Auth ID>/`; no credentials are stored. Without a bucket, files go to local disk (`VOBIZ_MEDIA_DIR`), which suits a single replica or local development only.

| Setting | Default | Purpose |
|---|---|---|
| `VOBIZ_MEDIA_BUCKET` | unset | Cloud Storage bucket for the library. Unset = local disk. |
| `VOBIZ_MEDIA_DIR` | `<os tmpdir>/vobiz-mcp-media` | Local-disk directory when no bucket is set. |
| `VOBIZ_MEDIA_MAX_INPUT_MB` | `15` | Largest accepted file, before conversion. |
| `VOBIZ_MEDIA_MAX_DURATION_SEC` | `300` | Longest accepted audio. |
| `VOBIZ_MEDIA_MAX_PER_ACCOUNT` | `50` | Files per account. |
| `VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY` | `20` | Uploads and imports per account per UTC day. |
| `VOBIZ_FFMPEG`, `VOBIZ_FFPROBE` | from `PATH` | ffmpeg and ffprobe binaries. |

The audio library is on whenever reminder calls are (`VOBIZ_REMINDERS`). Upload links are one-time within a replica; across replicas or a restart, a link is still bounded by its 15-minute lifetime.

## Scaling and operations

- **Stateless.** Any replica can serve any request, so run two or more behind a load balancer.
- **Per-replica state.** Rate-limit counters (sign-in, `/token`, `/register`, `/authorize`) and idempotency records live in memory on each replica. They protect each process; Vobiz's own CPS limits still apply across the account. Sessions and used authorization codes are shared through the grant store when Firestore is configured.
- **Logs.** Logs go to stderr and contain route templates, status codes and timings only. Tokens, message text and phone numbers are never logged.
- **Revocation.** A client ends one session with `POST /revoke`. A user revokes every session at once by rotating their Auth Token in the console: Vobiz refuses the old token on the next call, and the next refresh ends the session. The operator revokes everyone at once by rotating `VOBIZ_HOSTED_SECRET`.
