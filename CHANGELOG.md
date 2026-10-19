# Changelog

## 1.1.3

- Fix: **Allow access** on the hosted sign-in page now completes in browsers. The page's `form-action` policy now allows the client's callback origin, because browsers apply it to the redirect after the form post.
- The sign-in page follows the Vobiz brand guidelines: IBM Plex Sans, Vobiz Red `#E83C00`, Orange `#E86A00` and Dark Grey `#100703`, the official lockup, and light and dark themes matching vobiz.ai.

## 1.1.2

- Every Vobiz link uses `https://www.vobiz.ai`, the canonical host. The docs page is now `https://www.vobiz.ai/docs/resources/vobiz-mcp`.
- `npm run test:live:remote` runs the OAuth sign-in, tools and token refresh against a deployed connector (default `https://mcp.vobiz.ai`).

## 1.1.1

- Point the bundled Vobiz Docs MCP server at `https://www.vobiz.ai/docs/mcp`. MCP clients do not follow the apex-domain redirect on POST.

## 1.0.0

First public release, published as `@vobiz/mcp`.

**Added:**

- 49 more tools in four new toolsets:
  - conferences: list, inspect, end, member mute/deaf/kick/hangup/play, recording
  - media: live audio streams to wss:// agents, billing transactions, recording deletion, number release and sub-account assignment
  - sip: SIP endpoints, trunk credentials, IP allow-lists, origination URIs
  - subaccounts: CRUD, KYC status, hosted KYC session
- `VOBIZ_TOOLSETS` and `VOBIZ_READ_ONLY` to choose which tools the model sees; `--help` and `--version`.

- SMS, MMS and RCS tools: `send_message`, `preview_message_cost`, `list_messages`, `get_message`, `list_conversations`, `get_conversation_messages`, `list_messaging_numbers`, `list_broadcasts`, `get_broadcast`, `check_opt_out`, `list_opt_outs`, `add_opt_out`, `remove_opt_out`.
- The 15 Vobiz Agent Skills bundled as tools (`list_vobiz_skills`, `get_vobiz_skill`), prompts and `vobiz://skills/*` resources.
- A hosted multi-tenant connector (`vobiz-mcp hosted`, Docker). It includes OAuth 2.1 with PKCE, dynamic client registration and Client ID Metadata Documents; stateless sealed tokens; per-account limits; read-only consent; and Origin checks.
- Distribution: npm package with `bin`, an `.mcpb` desktop extension manifest, `server.json` for the MCP Registry, and release automation.

**Changed:**

- Every write tool is annotated `destructiveHint: true`, and every tool has a title.
- Balance tools use the account's own wallets (INR, USD and others). The default currency is no longer hard-coded.
- Destination countries are unrestricted by default (calling stays off until enabled). Product links are configurable.
- The server is renamed `vobiz` and the product name is spelled "Vobiz" throughout.
