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
| `POST /token`, `POST /register` | OAuth token and dynamic client registration (there is no `/revoke` endpoint: see **Revocation** below) |
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
| **Full access** (default) | Every tool, reminder tools included. Writes still need the user's confirmation. |
| **Personal assistant** | Only `schedule_reminder_call`, `list_reminder_calls`, `get_reminder_call`, `cancel_reminder_call`, `get_account_balance`, `list_phone_numbers`, `get_call_status` and the audio library tools (`create_audio_upload_link`, `import_audio_from_url`, `list_audio`, `delete_audio`). Reminder calls always go to the user's own number. |
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

- A Cloud Tasks queue in `VOBIZ_TASKS_LOCATION`, with bounded retries for transient failures:

  ```bash
  gcloud tasks queues create vobiz-reminders --location=asia-south1 \
    --max-attempts=5 --min-backoff=30s --max-backoff=300s --max-dispatches-per-second=10
  ```

  Tasks are HTTP tasks to `<VOBIZ_HOSTED_URL>/jobs/fire`. The job body is a sealed token that only this server can mint or open, so that token is the authentication. An OIDC token on the task is optional defence in depth (it needs `iam.serviceAccountUser` on the invoking account and invoker checks on the service). `/jobs/fire` answers 503 only for a transient failure and 200 for everything else, including an unreadable token, so a bad job is dropped instead of retried.
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
- **Per-replica state.** Rate-limit counters, idempotency records and used-code tracking live in memory on each replica. They protect each process; Vobiz's own CPS limits still apply across the account.
- **Logs.** Logs go to stderr and contain route templates, status codes and timings only. Tokens, message text and phone numbers are never logged.
- **Revocation.** A user revokes access by rotating their Auth Token in the console, which invalidates all of that account's tokens immediately. The operator revokes everyone at once by rotating `VOBIZ_HOSTED_SECRET`.

## Deployment hardening

The image and the release pipeline are built to be reproducible and least-privilege. Keep these properties when you fork or self-host.

- **Pinned base image.** The `Dockerfile` pins `node:24-alpine` by digest and `ffmpeg` to an exact Alpine package version. Dependabot (`docker` ecosystem) bumps the digest. When the digest moves to a new Alpine release, bump the `ffmpeg=` pin too (the `Dockerfile` comment shows how).
- **Small runtime.** The runtime stage removes npm, npx and corepack, runs as the unprivileged `node` user and has a `/health` `HEALTHCHECK`. `.dockerignore` keeps `.env*`, `.git`, `test/` and docs (other than `README.md`) out of the build context.
- **Pinned CI.** Every action in `.github/workflows` is pinned to a full commit SHA with a `# vX.Y.Z` comment, and Dependabot keeps them current. `npm ci` always runs with `--ignore-scripts`. Tokens are least-privilege per job: the workflow default is `permissions: {}`, and only the npm job gets `id-token: write`, the GitHub release job `contents: write` and the image job `packages: write`. Publishing workflows don't use the shared npm cache.
- **Verified tools.** The MCP Registry workflow downloads a pinned `mcp-publisher` release and checks its sha256 before running it.
- **`:latest` moves only forward.** A tag push publishes `ghcr.io/vobiz-ai/vobiz-mcp:<tag>`. It also moves `:latest`, but only when the tag is a stable `vX.Y.Z` (no prerelease suffix) and the highest stable semver tag in the repository. A backport or a release candidate never moves it. To re-point `:latest` by hand, run the **Release** workflow from the tag with **latest** ticked; the same check applies.
- **Deploy by digest.** Point your platform at `image@sha256:…` rather than a tag, and make your registry's tags immutable.
- **Edge protection.** In front of `/oauth/login` and `/register`, add a per-IP rate limit at your load balancer or WAF, and require TLS 1.2 or later. Keep in mind that AI clients call `/register` and `/mcp` from shared egress IPs, so set the limits per client range, not only per IP. Keep request logs for `/r/`, `/upload/` and `/media/` out of long-term storage, because those URLs carry sealed tokens.
