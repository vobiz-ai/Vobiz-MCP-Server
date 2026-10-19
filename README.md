# Vobiz MCP server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [Vobiz](https://www.vobiz.ai). It lets Claude and any other MCP client run real work on your Vobiz account:

- place and control voice calls, run conferences, and stream call audio to AI agents
- build VobizXML IVRs
- read call records and recordings
- manage phone numbers, SIP trunks, credentials, IP allow-lists, SIP endpoints, voice applications and sub-accounts
- read billing transactions
- send SMS, MMS and RCS messages

It also ships the **Vobiz Agent Skills**, so the model knows how each Vobiz product works before it acts.

[![CI](https://github.com/vobiz-ai/Vobiz-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/Vobiz-MCP-Server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vobiz/mcp)](https://www.npmjs.com/package/@vobiz/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

| | |
|---|---|
| **Tools** | 106 in 12 toolsets: calls, in-call control, conferences, audio streams, IVR/XML, records, numbers, SIP trunks and endpoints, applications, sub-accounts, billing, SMS/MMS/RCS, opt-outs, skills |
| **Prompts** | 15: one per Vobiz skill, e.g. `vobiz-voice-xml`, `vobiz-sip-trunking` |
| **Resources** | `vobiz://skills/index` and `vobiz://skills/{name}` (with completion) |
| **Transports** | stdio (`npx`), Streamable HTTP for one account, hosted multi-tenant Streamable HTTP with OAuth 2.1 |
| **Safety** | Calling, messaging and account changes are off until enabled. Every write is confirmed, rate-limited and idempotent. `VOBIZ_READ_ONLY` and `VOBIZ_TOOLSETS` narrow what the model can see. |

> Looking for documentation search instead of account operations? Use the hosted [Vobiz Docs MCP server](https://www.vobiz.ai/docs/resources/mcp) (`https://www.vobiz.ai/docs/mcp`). The two servers work well side by side.

## Contents

- [What you can ask](#what-you-can-ask)
- [Connect Claude in five steps](#connect-claude-in-five-steps)
- [Install](#install) (every client: [docs/INSTALL.md](docs/INSTALL.md))
- [Tools](#tools)
- [Skills, prompts and resources](#skills-prompts-and-resources)
- [Safety model](#safety-model)
- [Configuration](#configuration)
- [Run modes](#run-modes)
- [Hosted connector (OAuth)](#hosted-connector-oauth)
- [Privacy policy](#privacy-policy)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## What you can ask

| Ask Claude | What happens |
|---|---|
| "What's my Vobiz balance and how many calls are live?" | `get_account_balance`, `get_concurrency`, `list_live_calls` |
| "Show yesterday's missed calls to +91 80 1234 5678" | `list_call_records` filtered by date, number and `hangup_cause` |
| "Call +919876543210 from my Bangalore number and read them this reminder" | `list_phone_numbers` → you confirm → `make_call` → `speak_text` → `get_call_status` |
| "Build an IVR: press 1 for sales, 2 for support" | `get_vobiz_skill vobiz-voice-xml` → `generate_answer_xml` |
| "Text +14155550123 'Your order has shipped' from my US number" | `preview_message_cost` → you confirm → `send_message` → `get_message` |
| "Who replied to our last SMS broadcast?" | `list_broadcasts`, `list_messages direction=in`, `list_conversations` |
| "Block +14155550123 from future messages" | `add_opt_out` (you confirm) |
| "Where do my webhooks go?" | `list_webhooks` across applications and SIP trunks |
| "Set up a SIP trunk for my LiveKit agent" | `get_vobiz_skill vobiz-sip-trunking` → `create_sip_trunk` (you confirm) |
| "Mute everyone except the host in the sales-standup conference" | `get_conference` → `mute_conference_member` |
| "Stream this call's audio to my agent at wss://agent.example.com/ws" | `start_audio_stream` (you confirm) |
| "Allow our office IP 203.0.113.10 on the trunk and add a SIP user for the PBX" | `add_ip_acl_entry`, `create_trunk_credential` (you confirm) |
| "Create a sub-account for the Mumbai team and send them the KYC link" | `create_sub_account`, `create_sub_account_kyc_session` (you confirm) |
| "What did we spend last week?" | `list_transactions` with a date range |
| "How do I migrate my Plivo integration?" | `vobiz-plivo-migration` prompt |

## Connect Claude in five steps

Works in claude.ai, Claude Desktop and the Claude mobile apps. Nothing to install.

1. **Copy your credentials.** In the [Vobiz console](https://console.vobiz.ai) overview page, copy your **Auth ID** (`MA_…`, or `SA_…` for a sub-account) and **Auth Token**.
2. **Open Connectors.** In Claude, go to **Settings → Connectors → Add custom connector**. On Team and Enterprise plans an Owner adds it once under **Admin settings → Connectors**, then each member connects their own Vobiz account.
3. **Add the server.** Name it `Vobiz`, enter `https://mcp.vobiz.ai/mcp`, leave the advanced OAuth fields empty, and click **Add**.
4. **Connect and sign in.** Click **Connect**. On the Vobiz sign-in page, paste your Auth ID and Auth Token, optionally tick **Read-only access**, and click **Allow access**. You return to Claude, connected.
5. **Use it.** In a new chat, enable **Vobiz** in the tools menu and ask: *"What's my Vobiz balance, and how many calls are live right now?"*

| To | Do this |
|---|---|
| Switch between read-only and full access | **Settings → Connectors → Vobiz → Disconnect**, then **Connect** again and change **Read-only access** |
| Disconnect | **Settings → Connectors → Vobiz → Disconnect** |
| Revoke every app at once | Rotate your Auth Token in the Vobiz console |

Claude asks before it runs any tool that places a call, sends a message or changes your account, and the server requires your confirmation for each one. Number purchases are not offered by the hosted connector.

## Install

<!-- install:start -->
<!-- Generated by scripts/gen-clients.mjs. Run npm run clients:gen after changing the version. -->
You need a Vobiz account, plus its **Auth ID** and **Auth Token** from the overview page of the [Vobiz console](https://console.vobiz.ai). The full guide, with config files for every client, is [docs/INSTALL.md](docs/INSTALL.md).

### Connect in one step (hosted, recommended)

| Client | One step | Then |
|---|---|---|
| Claude (web, Desktop, mobile) | **Settings → Connectors → Add custom connector** → `https://mcp.vobiz.ai/mcp` | Click **Connect** and sign in ([5 steps](#connect-claude-in-five-steps)) |
| Claude Code | `claude mcp add --transport http vobiz https://mcp.vobiz.ai/mcp` | Run `/mcp`, pick **vobiz**, sign in |
| Claude Code (plugin: server + skills) | `/plugin install vobiz --marketplace vobiz-ai/Vobiz-MCP-Server` | Enter your Auth ID and Auth Token when asked |
| Claude Desktop (local extension) | Open `vobiz-mcp-v1.1.4.mcpb` from the [latest release](https://github.com/vobiz-ai/Vobiz-MCP-Server/releases/latest) | Enter your Auth ID and Auth Token |
| OpenAI Codex (CLI, IDE, app) | `codex mcp add vobiz --url https://mcp.vobiz.ai/mcp` | The Vobiz sign-in opens automatically |
| ChatGPT | **Plugins → + → Add custom MCP server** → `https://mcp.vobiz.ai/mcp` | Sign in, then use **@Vobiz** |
| Gemini CLI | `gemini mcp add -s user --transport http vobiz https://mcp.vobiz.ai/mcp` | Run `/mcp auth vobiz` |
| Cursor | [Add to Cursor](https://cursor.com/en/install-mcp?name=vobiz&config=eyJ1cmwiOiJodHRwczovL21jcC52b2Jpei5haS9tY3AifQ%3D%3D) | Click **Connect** in Cursor's MCP settings |
| VS Code / GitHub Copilot | [Add to VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=vobiz&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.vobiz.ai%2Fmcp%22%7D) | Start the server and sign in |
| Windsurf / Devin | `devin mcp add -s user vobiz https://mcp.vobiz.ai/mcp` | `devin mcp login vobiz` |
| Cline | `cline mcp add vobiz https://mcp.vobiz.ai/mcp --transport http --yes` | Choose **Authorize OAuth** |
| Goose | Open `goose://extension?url=…` ([link](docs/INSTALL.md#goose)) | Sign in |
| Zed, JetBrains, Warp, LM Studio, Continue | Add `{ "url": "https://mcp.vobiz.ai/mcp" }` as a server ([guide](docs/INSTALL.md)) | Sign in |

Every remote option signs in with OAuth on a Vobiz page, so no Auth Token is written to a config file. To run the server on your own machine instead, use the local options below.

### Run it locally

Local options run the server on your machine with `npx` and need Node.js 22.9 or newer.

| Client | Install |
|---|---|
| Claude (web, Desktop, mobile) | Settings → Connectors → Add custom connector → `https://mcp.vobiz.ai/mcp` |
| Claude Desktop extension | Open `vobiz-mcp-v1.1.4.mcpb` from the [latest release](https://github.com/vobiz-ai/Vobiz-MCP-Server/releases/latest) |
| Claude Code | `/plugin install vobiz --marketplace vobiz-ai/Vobiz-MCP-Server` (MCP server + skills) |
| OpenAI Codex | `codex mcp add vobiz --env VOBIZ_AUTH_ID=MA_XXXXXXXX --env VOBIZ_AUTH_TOKEN=YOUR_AUTH_TOKEN -- npx -y github:vobiz-ai/Vobiz-MCP-Server#v1.1.4` |
| Gemini CLI | `gemini extensions install https://github.com/vobiz-ai/Vobiz-MCP-Server` |
| Cursor | [One-click install](https://cursor.com/en/install-mcp?name=vobiz&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdpdGh1Yjp2b2Jpei1haS9Wb2Jpei1NQ1AtU2VydmVyI3YxLjEuNCJdLCJlbnYiOnsiVk9CSVpfQVVUSF9JRCI6IiR7ZW52OlZPQklaX0FVVEhfSUR9IiwiVk9CSVpfQVVUSF9UT0tFTiI6IiR7ZW52OlZPQklaX0FVVEhfVE9LRU59In19) |
| VS Code / Copilot | [One-click install](https://insiders.vscode.dev/redirect/mcp/install?name=vobiz&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22github%3Avobiz-ai%2FVobiz-MCP-Server%23v1.1.4%22%5D%2C%22env%22%3A%7B%22VOBIZ_AUTH_ID%22%3A%22%24%7Benv%3AVOBIZ_AUTH_ID%7D%22%2C%22VOBIZ_AUTH_TOKEN%22%3A%22%24%7Benv%3AVOBIZ_AUTH_TOKEN%7D%22%7D%7D) |
| Goose | `goose configure` → Add Extension → `npx -y github:vobiz-ai/Vobiz-MCP-Server#v1.1.4` ([deeplink](docs/INSTALL.md#goose)) |
| Windsurf, Zed, Cline, JetBrains, Continue, LM Studio, Warp, ChatGPT | [docs/INSTALL.md](docs/INSTALL.md) |

Any other MCP client:

```json
{
  "mcpServers": {
    "vobiz": {
      "command": "npx",
      "args": [
        "-y",
        "github:vobiz-ai/Vobiz-MCP-Server#v1.1.4"
      ],
      "env": {
        "VOBIZ_AUTH_ID": "MA_XXXXXXXX",
        "VOBIZ_AUTH_TOKEN": "YOUR_AUTH_TOKEN"
      }
    }
  }
}
```

Calling, messaging and account changes stay off until you add `VOBIZ_ENABLE_CALLS`, `VOBIZ_ENABLE_MESSAGING` or `VOBIZ_ENABLE_PROVISIONING` set to `"true"` to `env`.

To self-host the remote connector: `docker run -p 3000:3000 -e VOBIZ_HOSTED_URL=https://mcp.example.com -e VOBIZ_HOSTED_SECRET="$(openssl rand -hex 32)" ghcr.io/vobiz-ai/vobiz-mcp:v1.1.4` ([docs/HOSTING.md](docs/HOSTING.md)).
<!-- install:end -->

## Tools

Every tool has a `title`, input validation, and annotations: `readOnlyHint: true` or `destructiveHint: true`, plus `idempotentHint` and `openWorldHint`. Results are `structuredContent`, with the same JSON sent as text. [docs/TOOLS.md](docs/TOOLS.md) lists every input and is generated from the registry.

| Toolset | Read-only | Writes (need confirmation) |
|---|---|---|
| `calls` | `get_call_status`, `list_live_calls` | `make_call`, `end_call`, `send_dtmf` |
| `call_control` | | `transfer_call`, `hold_call`, `unhold_call`, `play_audio`, `stop_audio`, `speak_text`, `stop_speaking`, `start_recording`, `stop_recording` |
| `conferences` | `list_conferences`, `get_conference` | `end_conference`, `end_all_conferences`, `mute_conference_member`, `unmute_conference_member`, `deafen_conference_member`, `undeafen_conference_member`, `kick_conference_member`, `hangup_conference_member`, `play_audio_to_conference_member`, `stop_audio_to_conference_member`, `start_conference_recording`, `stop_conference_recording` |
| `media` | `list_audio_streams`, `get_audio_stream`, `list_transactions`, `list_transaction_types` | `start_audio_stream`, `stop_audio_stream`, `delete_recording`, `release_phone_number`, `cancel_number_release`, `assign_number_to_subaccount`, `unassign_number_from_subaccount` |
| `records` | `get_call_details`, `list_call_records`, `get_call_recording`, `list_recordings` | |
| `voice_xml` | `generate_answer_xml`, `get_gather_result`, `list_webhook_events`, `list_webhooks` | `gather_dtmf` |
| `account` | `get_account_details`, `get_account_balance`, `get_concurrency`, `list_phone_numbers`, `get_phone_number_details`, `get_number_health`, `list_sip_trunks`, `get_sip_trunk` | |
| `provisioning` | `list_applications`, `get_application`, `search_available_numbers` | `create_application`, `update_application`, `delete_application`, `buy_phone_number`, `update_phone_number`, `create_sip_trunk`, `update_sip_trunk`, `delete_sip_trunk` |
| `sip` | `list_sip_endpoints`, `get_sip_endpoint`, `list_trunk_credentials`, `list_ip_acl_entries`, `list_origination_uris` | `create_sip_endpoint`, `update_sip_endpoint`, `delete_sip_endpoint`, `create_trunk_credential`, `update_trunk_credential`, `delete_trunk_credential`, `add_ip_acl_entry`, `update_ip_acl_entry`, `delete_ip_acl_entry`, `create_origination_uri`, `update_origination_uri`, `delete_origination_uri` |
| `subaccounts` | `list_sub_accounts`, `get_sub_account`, `get_sub_account_kyc_status` | `create_sub_account`, `update_sub_account`, `delete_sub_account`, `create_sub_account_kyc_session` |
| `messaging` | `list_messaging_numbers`, `preview_message_cost`, `list_messages`, `get_message`, `list_conversations`, `get_conversation_messages`, `list_broadcasts`, `get_broadcast`, `check_opt_out`, `list_opt_outs` | `send_message`, `add_opt_out`, `remove_opt_out` |
| `skills` | `list_vobiz_skills`, `get_vobiz_skill` | |

**Choosing tools.** 106 tools is a lot for some clients. Load only what you need:

- `VOBIZ_TOOLSETS=calls,call_control,records,skills` registers just those groups.
- `VOBIZ_READ_ONLY=true` keeps only the read-only tools.

**Secrets.** SIP passwords, credential secrets and sub-account tokens are always redacted. Reset or copy them in the Vobiz console.

**Hosting needed.** `gather_dtmf`, `get_gather_result`, `list_webhook_events`, `hold_call` and `unhold_call` need Vobiz to reach this server. Use single-account HTTP mode with `VOBIZ_PUBLIC_URL` for them.

**Errors.** Errors are MCP tool errors (`isError: true`) shaped like this:

```json
{ "ok": false, "error": "not_allowed", "message": "…what happened and what to do…", "retryable": false, "http_status": 400, "hint": "…" }
```

**Error kinds.**

- Input and access: `invalid_input`, `missing_credentials`, `auth_failed`, `forbidden`, `not_found`, `insufficient_balance`
- Limits and availability: `rate_limited`, `timeout`, `network_error`, `service_unavailable`
- Server switches and policy: `calls_disabled`, `messaging_disabled`, `provisioning_disabled`, `confirmation_required`, `not_allowed`, `spending_limit`
- Idempotency: `duplicate_blocked`, `idempotency_conflict`, `in_progress`, `outcome_unknown`
- Other: `call_not_active`, `opted_out`, `unsupported`, `internal_error`

**Call outcomes.** Call results add `outcome` (`answered`, `busy`, `no_answer`, `rejected`, `invalid_number`, `unreachable`, `cancelled`…) with the typical SIP code.

## Skills, prompts and resources

The 15 [Vobiz Agent Skills](https://www.vobiz.ai/docs/resources/skills) ship inside the package (`skills/`) and are exposed three ways, so they work in every client:

| Surface | How to use it |
|---|---|
| Tools | `list_vobiz_skills` returns each skill's name, description and sections. `get_vobiz_skill { name, section? }` returns the whole skill or one section. |
| Prompts | Each skill is a prompt with an optional `task` argument. In Claude Code, type `/mcp__vobiz__vobiz-voice-xml build an IVR for a clinic`. |
| Resources | `vobiz://skills/index` and `vobiz://skills/{name}`, with name completion. |

The skills:

- **Voice and calls:** `vobiz-api`, `vobiz-voice-calls`, `vobiz-voice-xml`, `vobiz-audio-streams`, `vobiz-cdr`
- **Numbers and infrastructure:** `vobiz-phone-numbers`, `vobiz-sip-trunking`, `vobiz-applications-endpoints`
- **AI and messaging:** `vobiz-ai-voice-agents`, `vobiz-sms`, `vobiz-whatsapp`
- **Accounts and partners:** `vobiz-sub-accounts`, `vobiz-partner-api`
- **Migration and scoping:** `vobiz-plivo-migration`, `vobiz-forward-deployed-engineer`

The skills come from the Vobiz docs repository. Refresh them with `npm run skills:sync [path/to/.mintlify/skills]`.

## Safety model

Everything below is enforced by the server, not left to the model.

| Guard | Default |
|---|---|
| Outbound calls | Off (`VOBIZ_ENABLE_CALLS`) |
| Sending messages, changing opt-outs | Off (`VOBIZ_ENABLE_MESSAGING`) |
| Buying or releasing numbers; changing trunks, SIP endpoints, credentials, IP allow-lists, applications and sub-accounts; deleting recordings | Off (`VOBIZ_ENABLE_PROVISIONING`). Purchases also need `VOBIZ_MAX_NUMBER_COST` > 0. |
| Explicit confirmation | `confirm: true` on every call, message, transfer, recording, purchase and account change. MCP clients also prompt for every destructive tool. |
| Idempotency | `idempotency_key` replays the first result instead of acting twice. Identical calls inside `VOBIZ_DUPLICATE_CALL_WINDOW_SEC` are refused. Unknown outcomes stay blocked. |
| Call limits | Destination countries and blocked prefixes, plus caps on duration, per-minute and per-hour calls, and concurrency. A balance floor applies to prepaid accounts. |
| Message limits | Recipients per send, messages per minute and per hour, recipient countries. Senders must be messaging numbers on the account. Opt-outs are respected. |
| Number purchases | Cost cap, daily cap, balance pre-check, already-owned check |
| Call-control URLs | https only, approved hosts only (hosted mode: any public host). No credentials in URLs. |
| Tenant isolation | The account comes from the credentials only. No tool accepts an account ID. |
| Secrets | Auth tokens, SIP passwords and other secrets are redacted from results. Logs carry route templates and status codes only, never phone numbers or tokens. |
| Untrusted content | Message bodies, caller names and callback payloads are data, never instructions. |

## Configuration

All settings are environment variables. Every one is optional except credentials (and the hosted settings for hosted mode). [`.env.example`](.env.example) lists them all with comments.

| Area | Variables (default) |
|---|---|
| Tool selection | `VOBIZ_TOOLSETS` (all), `VOBIZ_READ_ONLY` (false) |
| Credentials | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_BASE_URL` (`https://api.vobiz.ai`), `VOBIZ_ENV` (`development`), `VOBIZ_TIMEOUT_MS` (15000), `VOBIZ_LOG_LEVEL` (`info`), `VOBIZ_DEFAULT_PAGE_SIZE` (20) |
| Calls | `VOBIZ_ENABLE_CALLS` (false), `VOBIZ_DEFAULT_ANSWER_URL`, `VOBIZ_VERIFY_CALLER_ID` (true), `VOBIZ_ALLOWED_COUNTRY_CODES` (any), `VOBIZ_BLOCKED_PREFIXES`, `VOBIZ_ALLOWED_DESTINATIONS`, `VOBIZ_ALLOWED_CALLER_IDS`, `VOBIZ_MAX_CALL_DURATION_SEC` (600), `VOBIZ_MAX_CALLS_PER_MINUTE` (5), `VOBIZ_MAX_CALLS_PER_HOUR` (30), `VOBIZ_MAX_CONCURRENT_CALLS` (3), `VOBIZ_CHECK_BALANCE` (true), `VOBIZ_MIN_BALANCE` (0), `VOBIZ_BALANCE_CURRENCY` (primary wallet), `VOBIZ_DUPLICATE_CALL_WINDOW_SEC` (120), `VOBIZ_IDEMPOTENCY_FILE` |
| Messaging | `VOBIZ_ENABLE_MESSAGING` (false), `VOBIZ_MESSAGING_ALLOWED_COUNTRY_CODES` (any), `VOBIZ_MAX_RECIPIENTS_PER_SEND` (10), `VOBIZ_MAX_MESSAGES_PER_MINUTE` (20), `VOBIZ_MAX_MESSAGES_PER_HOUR` (200), `VOBIZ_VERIFY_SENDER` (true) |
| Account changes (numbers, trunks, SIP, applications, sub-accounts, recordings) | `VOBIZ_ENABLE_PROVISIONING` (false), `VOBIZ_MAX_NUMBER_COST` (0 = no purchases), `VOBIZ_MAX_NUMBER_PURCHASES_PER_DAY` (1) |
| URLs | `VOBIZ_ALLOWED_URL_HOSTS`, `VOBIZ_ALLOW_ANY_URL_HOST` (false) |
| Links | `VOBIZ_CONSOLE_URL`, `VOBIZ_PRIVACY_URL`, `VOBIZ_DOCS_URL`, `VOBIZ_DOCS_MCP_URL` (public Vobiz URLs) |
| Single-account HTTP | `PORT` (3000), `HOST` (127.0.0.1), `VOBIZ_HTTP_SECRET`, `VOBIZ_PUBLIC_URL`, `VOBIZ_REMOTE_ALLOW_CALLS` (false), `VOBIZ_WEBHOOK_SIGNATURE` (`require`), `VOBIZ_ANSWER_TEXT` |
| Hosted connector | `VOBIZ_HOSTED_URL`, `VOBIZ_HOSTED_SECRET`, `VOBIZ_ACCESS_TOKEN_TTL_SEC` (3600), `VOBIZ_REFRESH_TOKEN_TTL_SEC` (2592000), `VOBIZ_CIMD_HOSTS` (`claude.ai`), `VOBIZ_ALLOWED_ORIGINS` (`https://claude.ai,https://claude.com`), `VOBIZ_HOSTED_EXCLUDED_TOOLS` |

## Run modes

| Mode | Command | For |
|---|---|---|
| **stdio** | `npx -y @vobiz/mcp` (or `node dist/index.js`) | Claude Desktop, Claude Code, Cursor and other local clients on one account |
| **Single-account HTTP** | `npx -y @vobiz/mcp http` (or `npm run start:http`) | One account over Streamable HTTP behind a path secret; hosted IVR flows, gather, signed webhooks |
| **Hosted multi-tenant** | `npx -y @vobiz/mcp hosted` (or `npm run start:hosted`, Docker) | Public connector: each user signs in with OAuth and acts only on their own account |
| **Dashboard** | `npm run dashboard` → http://127.0.0.1:5178 | Read-only local browser view built on the same tools |

### Single-account HTTP endpoints

| Path | Purpose | Auth |
|---|---|---|
| `/mcp/<VOBIZ_HTTP_SECRET>` | Streamable HTTP MCP | path secret |
| `/sse/<secret>`, `/message/<secret>` | legacy SSE MCP for older clients | path secret |
| `/xml/flow/<id>` | hosted XML (answer, transfer, hold, dial) | Vobiz signature + 128-bit ID |
| `/xml/gather/<id>` | Gather `Digits` callback; returns follow-up XML | Vobiz signature + ID |
| `/webhooks/vobiz` | answer, hangup and status callbacks | Vobiz signature |
| `/answer` | static `<Speak>` XML | none |
| `/health` | liveness | none |

**Callback signatures.** Callbacks are checked with `X-Vobiz-Signature-V3 = base64(HMAC-SHA256(auth_token, URL-without-query + "." + nonce))`. V2 is accepted as a fallback, and the comparison is constant-time. Reused nonces are rejected, and duplicate events are stored once.

## Hosted connector (OAuth)

`vobiz-mcp hosted` is a complete OAuth 2.1 authorization server and MCP resource server in one process. It is built for Claude's connector directory and works with any remote MCP client.

**Sign-in flow:**

1. Claude calls `POST /mcp` without a token. The server answers `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. Claude reads the protected-resource metadata (RFC 9728, `resource` = `<VOBIZ_HOSTED_URL>/mcp`) and the authorization-server metadata (RFC 8414). The AS metadata advertises PKCE S256, dynamic client registration (RFC 7591) and Client ID Metadata Documents.
3. Claude registers itself, or uses its CIMD URL, and opens `/authorize`. The user enters their Auth ID and Auth Token and can tick **read-only access**. The server checks the credentials with Vobiz, then redirects back with a single-use code.
4. `/token` exchanges the code (PKCE checked) for a 1-hour access token and a 30-day refresh token.

**Token handling:**

- Tokens are AES-256-GCM sealed, so no credential database is needed and any number of replicas can share `VOBIZ_HOSTED_SECRET`.
- Each request runs on the signed-in account only, with per-account rate limits and idempotency.
- Rotating the Auth Token in the Vobiz console revokes every token for that account immediately.

**Tool exclusions.** The hosted connector leaves out tools that buy things or need the server to host one account's callbacks. The default list is `buy_phone_number`, `gather_dtmf`, `get_gather_result`, `list_webhook_events`, `hold_call` and `unhold_call`, and you can change it with `VOBIZ_HOSTED_EXCLUDED_TOOLS`. Browser `Origin` headers are checked against `VOBIZ_ALLOWED_ORIGINS`.

Deployment, DNS, scaling and directory submission are covered in [docs/HOSTING.md](docs/HOSTING.md) and [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Privacy policy

This server is published by Vobiz (Ilaimitado Private Limited). The full policy is at <https://www.vobiz.ai/privacy>.

**What it processes:**

- Your Vobiz Auth ID and Auth Token, used only to authenticate your requests to the Vobiz API.
- The tool arguments the MCP client sends, such as phone numbers, message text and call settings.
- The Vobiz API responses it returns to the client.

**What it stores:**

- **Local modes:** credentials stay in your environment or OS keychain. Idempotency records stay in memory, or in `VOBIZ_IDEMPOTENCY_FILE` if you set it.
- **Hosted mode:** the server keeps no credential or conversation database. Credentials travel inside encrypted, expiring tokens held by your MCP client. Per-account rate-limit counters and idempotency records live in memory for up to 24 hours.

**What it never does:** it does not read your conversation history, memory or files. It does not use your data for advertising, and it does not sell or share it with third parties.

**Logs:** logs contain route templates, HTTP status codes and timings. They never contain tokens, message text or phone numbers.

**Retention:** call records, recordings and messages remain in your Vobiz account under the Vobiz terms (<https://www.vobiz.ai/terms>).

**Contact:** support@vobiz.ai

## Development

```bash
git clone https://github.com/vobiz-ai/Vobiz-MCP-Server.git
cd Vobiz-MCP-Server
npm ci
cp .env.example .env        # placeholders only; fill in your own credentials
npm run check               # type-check, build, 253 mocked tests
npm run test:live           # live read-only smoke test with .env credentials (calls/messages/purchases forced off)
npm run test:live:hosted    # live OAuth flow + hosted tools against the real API (no messages sent)
npm run inspector           # MCP Inspector against dist/index.js
npm run docs:tools          # regenerate docs/TOOLS.md
npm run skills:sync         # refresh bundled skills from the docs repository
```

**Code layout:**

- Tools live in `src/tools/{calls,control,conferences,media,records,account,voice,provisioning,sip,subaccounts,messaging}.ts`. Each file is one toolset, registered in `src/server.ts`.
- Skills are in `src/skills.ts`.
- Guardrails are in `src/policy.ts`, `src/idempotency.ts` and `src/outcomes.ts`.
- VobizXML generation is in `src/xml.ts`, hosted flows in `src/flows.ts`, and callback verification in `src/webhooks.ts`.
- Transports are in `src/index.ts` (stdio), `src/http.ts` (single account) and `src/hosted.ts` (OAuth multi-tenant).

**Tests:**

- Mocked tests never touch the network, and no test places a call, sends a message or buys a number.
- CI runs lint, build, the tests on Node 22 and 24, `npm audit`, the `.mcpb` manifest check and a package dry-run.
- Releases are tag-driven (`v1.2.3`). They publish to npm with provenance and to the MCP Registry, attach the `.mcpb` bundle, and push the Docker image (see [docs/PUBLISHING.md](docs/PUBLISHING.md)).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `missing_credentials` / `auth_failed` | Set or rotate `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN`. In hosted mode, reconnect the connector. |
| `forbidden` on account details | Account details need main-account (`MA_`) credentials. Balance, concurrency and numbers work with sub-accounts. |
| `calls_disabled` / `messaging_disabled` / `provisioning_disabled` | Enable the capability (environment variable, or the desktop extension settings). |
| `confirmation_required` | The model must ask you, then repeat the call with `confirm: true`. |
| `not_allowed` | Destination or recipient country, blocked prefix, allowlist, sender or caller ID not on the account, or URL host not approved |
| `rate_limited` | Server caps (minute, hour, concurrency, messages) or the account's CPS limit. Wait and retry. |
| `duplicate_blocked` | Same call within `VOBIZ_DUPLICATE_CALL_WINDOW_SEC`. Pass a new `idempotency_key` if a second call is intended. |
| `outcome_unknown` | Do not retry. Check `list_live_calls`, `list_call_records` or `list_messages`. |
| `unsupported` on gather or hold | Run single-account HTTP mode with `VOBIZ_PUBLIC_URL`. |
| Callbacks rejected with 401 | `VOBIZ_PUBLIC_URL` must match the URL Vobiz calls exactly. Try `VOBIZ_WEBHOOK_SIGNATURE=verify_if_present`. |
| Hosted sign-in says the link expired | The sign-in page is valid for 15 minutes. Start the connection again from your client. |

## Built by Team Vobiz

[Vobiz](https://www.vobiz.ai) is a global programmable telephony platform: SIP trunking, voice APIs, SMS, WhatsApp and AI voice agent integrations in 130+ countries.

**Support:** support@vobiz.ai · [Documentation](https://www.vobiz.ai/docs) · [Issues](https://github.com/vobiz-ai/Vobiz-MCP-Server/issues) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE) © Vobiz
