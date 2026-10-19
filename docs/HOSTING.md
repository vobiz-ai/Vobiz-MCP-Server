# Hosting the Vobiz MCP connector

The hosted connector (`dist/hosted.js`, Docker image `ghcr.io/vobiz-ai/vobiz-mcp`) is a stateless, multi-tenant MCP server over Streamable HTTP, with a built-in OAuth 2.1 authorization server. Every user signs in with their own Vobiz Auth ID and Auth Token. The server stores no credentials: they are sealed (AES-256-GCM) inside the tokens it issues.

## Requirements

| Item | Value |
|---|---|
| Public URL | An https origin, e.g. `https://mcp.vobiz.ai`. The MCP endpoint is `<origin>/mcp`. |
| TLS | Terminated at your load balancer or ingress. The app listens on plain HTTP (`PORT`, default 3000). |
| Secret | `VOBIZ_HOSTED_SECRET`: at least 32 random characters, the same on every replica, and stable across deploys. Rotating it signs every user out. |
| Egress | `https://api.vobiz.ai` (or `VOBIZ_BASE_URL`), plus `https://claude.ai` for Client ID Metadata Documents |
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
| `GET /health` | Liveness (`{"ok":true,"version":"…"}`) |

## Verify a deployment

```bash
curl -s https://mcp.vobiz.ai/health
curl -s https://mcp.vobiz.ai/.well-known/oauth-protected-resource/mcp   # resource must equal https://mcp.vobiz.ai/mcp
curl -si -X POST https://mcp.vobiz.ai/mcp | grep -i www-authenticate     # 401 with resource_metadata=
npx @modelcontextprotocol/inspector                                       # connect to https://mcp.vobiz.ai/mcp, sign in, run each tool
```

Then add it in Claude: go to **Settings → Connectors → Add custom connector** and enter `https://mcp.vobiz.ai/mcp`. Sign in, then run the example prompts in [PUBLISHING.md](PUBLISHING.md).

## Scaling and operations

- **Stateless.** Any replica can serve any request, so run two or more behind a load balancer.
- **Per-replica state.** Rate-limit counters, idempotency records and used-code tracking live in memory on each replica. They protect each process; Vobiz's own CPS limits still apply across the account.
- **Logs.** Logs go to stderr and contain route templates, status codes and timings only. Tokens, message text and phone numbers are never logged.
- **Revocation.** A user revokes access by rotating their Auth Token in the console, which invalidates all of that account's tokens immediately. The operator revokes everyone at once by rotating `VOBIZ_HOSTED_SECRET`.
