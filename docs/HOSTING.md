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
| `GET /mcp/server-card`, `GET /.well-known/mcp/server-card.json` | MCP server card (draft extension): name, version, Streamable HTTP endpoint and protocol versions; public, cached for an hour, no tool list |
| `GET /authorize` | Sign-in and consent page |
| `POST /oauth/login` | Consent form submission (checks the credentials with Vobiz) |
| `POST /token`, `POST /register` | OAuth token (code exchange and refresh-token rotation) and dynamic client registration |
| `POST /revoke` | Token revocation (RFC 7009): revoking an access or refresh token ends that whole sign-in |
| `GET /favicon.svg`, `GET /favicon.ico` | The Vobiz logomark for the sign-in and upload pages (`.ico` redirects to `.svg`) |
| `GET`/`POST /answer` | Default answer XML for `make_call` |
| `POST /jobs/fire` | Reminder-call job delivery from Cloud Tasks (body: sealed job token) |
| `POST /r/:token/answer`, `/r/:token/input`, `/r/:token/hangup` | Vobiz callbacks for a reminder call (sealed per-call token) |
| `GET`/`PUT /upload/:token` | Audio upload page, and the raw upload it sends (sealed one-time link, 15 minutes) |
| `GET`/`HEAD /media/:token` | A library file as WAV, fetched by Vobiz for `<Play>` on a reminder call (sealed link, 20 minutes) |
| `GET`/`POST /c/:token/answer` | VobizXML for a `make_call` with `say` / `play`: Play and/or Speak, then Hangup (sealed `vbzs_` token, 20 minutes; an invalid or expired token gets a "no longer active" script, never a 4xx) |
| `POST /c/:token/hangup` | Hangup callback for such a call: `200 {"ok":true}`, logs `calls: script hangup cause=… duration=…` only |
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

- A Cloud Tasks queue in `VOBIZ_TASKS_LOCATION`, with bounded retries for transient failures:

  ```bash
  gcloud tasks queues create vobiz-reminders --location=asia-south1 \
    --max-attempts=5 --min-backoff=30s --max-backoff=300s --max-dispatches-per-second=10
  ```

  Tasks are HTTP tasks to `<VOBIZ_HOSTED_URL>/jobs/fire`. The job body is a sealed token that only this server can mint or open, so that token is the authentication. An OIDC token on the task is optional defence in depth (it needs `iam.serviceAccountUser` on the invoking account and invoker checks on the service). `/jobs/fire` answers 503 only for a transient failure and 200 for everything else, including an unreadable token, so a bad job is dropped instead of retried.
- Firestore in Native mode (the `(default)` database or the one in `VOBIZ_FIRESTORE_DATABASE`).
- The Cloud Run service account needs `roles/cloudtasks.enqueuer` and `roles/cloudtasks.taskDeleter` on the queue (or `roles/cloudtasks.admin` on the project) and `roles/datastore.user`.

**Memory fallback.** Without the three Cloud Tasks variables, reminders are kept in memory and fired with timers. This is for local development and single-replica tests only: run exactly one replica, and expect every scheduled reminder to be lost on restart or scale-down. The connector logs a warning at startup in this mode.

**Limits.** The active-reminder cap and the per-destination daily cap are counted with equality queries (`account` + `status`, `account` + `toDigits`), which run on Firestore's automatic single-field indexes, so they cover every record however large the account is. The daily cap counts call attempts already started that UTC day plus every attempt a pending reminder to the number may still make. Schedule re-checks both caps in the same Firestore transaction as the write, serialised on a per-account lock document (`<account hash>__limits` in the reminders collection), so parallel schedules cannot overshoot. The daily cap is enforced again when each call fires: an attempt over the cap is recorded as failed (`daily_cap`) and not dialled.

**Fire-time safety.** A job delivered more than 90 seconds before its time is ignored (`too_early`, HTTP 200, so Cloud Tasks does not retry). A Vobiz 500, 502, 504, a 503 without `Retry-After`, or a timeout means the call may already be ringing: the attempt is recorded as `outcome_unknown` and retried after `retry_minutes`, within `max_attempts`. Only a 429, a 503 with `Retry-After`, or a refused connection gives the job back to Cloud Tasks (HTTP 503) for redelivery. A claimed attempt with no sign of a placed call is held for 10 minutes (redeliveries get HTTP 503 `in_progress`) and re-dialled after that. Per-call callback links expire after 15 minutes.

**Callback binding.** Each call's callbacks must carry the same `RequestUUID` the Call API returned and the same `CallUUID` as the first callback that carried one. A callback for another call gets the "no longer active" script (answer and input) or is ignored (hangup), with a `WARNING` log line. A hangup without these fields is still accepted.

**Callback signatures.** Reminder callbacks use `VOBIZ_WEBHOOK_SIGNATURE` when you set it explicitly. When it is unset, they use `verify_if_present`: a signature that is present must be valid, and an unsigned callback is accepted (the sealed per-call token in the URL already authenticates it). Each callback logs one line:

```
reminders: callback answer r=r_8f2k… n=1 signature=valid callUuid=present
```

To switch to `require`:

1. Place a few reminder calls on the deployed connector.
2. Check the logs for `reminders: callback` lines. Every `answer`, `input` and `hangup` line must show `signature=valid`. If any shows `signature=absent`, Vobiz does not sign that callback, and `require` would cut those calls off.
3. Set `VOBIZ_WEBHOOK_SIGNATURE=require` on the service and redeploy. Unsigned or invalid callbacks then get HTTP 403.

### Audio library

Users can play their own audio (an alarm sound, a recorded message) at the start of a reminder call, before the spoken message. Files land in one private library per account, three ways:

1. `create_audio_upload_link` returns a one-time link to `/upload/:token`. The page takes a file (pick or drop) or records from the microphone, up to 5 minutes. A link is good for one attempt: a failed upload uses it up.
2. The same link accepts a direct `PUT` with the raw file and an `X-Audio-Name` header (or `?name=`). Claude's code sandbox and similar tools use this when the user attached the file in the chat.
3. `import_audio_from_url` downloads a public https link: https on port 443 or 8443 only, size-capped, at most 3 redirects. On every hop the server resolves the host name and refuses it when any address is private, loopback, link-local, reserved or a cloud metadata address, then connects to exactly the address it checked (no DNS rebinding). Every network or upstream failure answers the same generic message.

Every file is checked and converted with ffmpeg to 8 kHz mono 16-bit WAV, loudness-normalised, with leading silence trimmed. `schedule_reminder_call` takes the file's name as `audio`. When the call is answered, the connector hands Vobiz a fresh `/media/:token` link (valid 20 minutes) for `<Play>`, so files are never public. A file deleted after scheduling is skipped: the call still speaks its message.

**ffmpeg.** The Docker image includes `ffmpeg` and `ffprobe`. Elsewhere, install them on `PATH` or point `VOBIZ_FFMPEG` / `VOBIZ_FFPROBE` at the binaries. Without them the connector starts, logs a warning, and refuses uploads and imports with a clear message; reminder calls with `audio_url` keep working.

**Conversion sandbox.** The server recognises the container from the file's first bytes (MP3, WAV, M4A/MP4, OGG, WebM/Matroska, AAC, FLAC) and refuses anything else before ffmpeg starts. ffprobe and ffmpeg run with an explicit input format, `-protocol_whitelist file,pipe`, one thread, a 25-second limit and only `PATH` in their environment, so no secret reaches them. A file whose probed duration is over the limit is refused before decoding. At most `VOBIZ_AUDIO_MAX_CONCURRENT` conversions run at once per instance; a request that waits more than 10 seconds for a slot gets `rate_limited` (HTTP 429).

**Storage.** Set `VOBIZ_MEDIA_BUCKET` to a private Google Cloud Storage bucket for production (every replica sees the same files). Grant the Cloud Run service account `roles/storage.objectAdmin` on the bucket, and keep public access prevention on. Files live under `accounts/<hash of the Auth ID>/`; no credentials are stored. Without a bucket, files go to local disk (`VOBIZ_MEDIA_DIR`), which suits a single replica or local development only.

| Setting | Default | Purpose |
|---|---|---|
| `VOBIZ_MEDIA_BUCKET` | unset | Cloud Storage bucket for the library. Unset = local disk. |
| `VOBIZ_MEDIA_DIR` | `<os tmpdir>/vobiz-mcp-media` | Local-disk directory when no bucket is set. |
| `VOBIZ_MEDIA_MAX_INPUT_MB` | `15` | Largest accepted file, before conversion. |
| `VOBIZ_MEDIA_MAX_DURATION_SEC` | `300` | Longest accepted audio. |
| `VOBIZ_MEDIA_MAX_PER_ACCOUNT` | `50` | Files per account. |
| `VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY` | `20` | Upload and import attempts per account per UTC day. Failed attempts count, and deleting files does not reset it. |
| `VOBIZ_AUDIO_MAX_CONCURRENT` | `2` | Conversions running at once per instance (1 to 16). |
| `VOBIZ_FFMPEG`, `VOBIZ_FFPROBE` | from `PATH` | ffmpeg and ffprobe binaries. |

The audio library is on whenever reminder calls are (`VOBIZ_REMINDERS`). Upload links are one-time within a replica; across replicas or a restart, a link is still bounded by its 15-minute lifetime.

**Caps across replicas.** The daily counter is stored next to the library (`counters/<hash>.json`; on Cloud Storage it is updated with a generation precondition), so it holds across replicas and restarts. The total-files cap counts the stored files. The one-conversion-per-account lock is in memory, so it holds per instance: with several replicas an account can convert one file per replica at a time.

## Scaling and operations

- **Stateless.** Any replica can serve any request, so run two or more behind a load balancer.
- **Per-replica state.** Rate-limit counters for the OAuth endpoints (sign-in, `/token`, `/register`, `/authorize`) live in memory on each replica. They protect each process; Vobiz's own CPS limits still apply across the account.
- **Shared state.** When `VOBIZ_GCP_PROJECT` is set, Firestore holds idempotency records for calls, messages and number purchases (collection `idempotency`, up to 24 hours), the call and message rate counters (collection `counters`, until their minute or hour window ends), sessions and used authorization codes (the grant store, sessions up to 90 days) and reminder calls (`VOBIZ_FIRESTORE_COLLECTION`). Every idempotency, counter and grant document carries an expiry timestamp (`expiresAt` or `expireAt`): add a Firestore TTL policy on it. The audio library lives in `VOBIZ_MEDIA_BUCKET`. Without a GCP project, idempotency records and counters stay in memory on each replica.
- **Logs.** Logs go to stderr and contain route templates, status codes and timings only. Tokens, message text and phone numbers are never logged.
- **Revocation.** A client ends one session with `POST /revoke`. A user revokes every session at once by rotating their Auth Token in the console: Vobiz refuses the old token on the next call, and the next refresh ends the session. The operator revokes everyone at once by rotating `VOBIZ_HOSTED_SECRET`.

## Deployment hardening

The image and the release pipeline are built to be reproducible and least-privilege. Keep these properties when you fork or self-host.

- **Pinned base image.** The `Dockerfile` pins `node:24-alpine` by digest and `ffmpeg` to an exact Alpine package version. Dependabot (`docker` ecosystem) bumps the digest. When the digest moves to a new Alpine release, bump the `ffmpeg=` pin too (the `Dockerfile` comment shows how).
- **Small runtime.** The runtime stage removes npm, npx and corepack, runs as the unprivileged `node` user and has a `/health` `HEALTHCHECK`. `.dockerignore` keeps `.env*`, `.git`, `test/` and docs (other than `README.md`) out of the build context.
- **Pinned CI.** Every action in `.github/workflows` is pinned to a full commit SHA with a `# vX.Y.Z` comment, and Dependabot keeps them current. `npm ci` always runs with `--ignore-scripts`. Tokens are least-privilege per job: the workflow default is `permissions: {}`, and only the npm job gets `id-token: write`, the GitHub release job `contents: write` and the image job `packages: write`. Publishing workflows don't use the shared npm cache.
- **Verified tools.** The MCP Registry workflow downloads a pinned `mcp-publisher` release and checks its sha256 before running it.
- **`:latest` moves only forward.** A tag push publishes `ghcr.io/vobiz-ai/vobiz-mcp:<tag>`. It also moves `:latest`, but only when the tag is a stable `vX.Y.Z` (no prerelease suffix) and the highest stable semver tag in the repository. A backport or a release candidate never moves it. To re-point `:latest` by hand, run the **Release** workflow from the tag with **latest** ticked; the same check applies.
- **Deploy by digest.** Point your platform at `image@sha256:…` rather than a tag, and make your registry's tags immutable.
- **Edge protection.** In front of `/oauth/login` and `/register`, add a per-IP rate limit at your load balancer or WAF, and require TLS 1.2 or later. Keep in mind that AI clients call `/register` and `/mcp` from shared egress IPs, so set the limits per client range, not only per IP. Keep request logs for `/r/`, `/upload/` and `/media/` out of long-term storage, because those URLs carry sealed tokens.
