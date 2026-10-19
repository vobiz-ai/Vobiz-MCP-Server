# Publishing checklist

The steps to release the Vobiz MCP server everywhere: npm, the official MCP Registry, the `.mcpb` desktop extension, Docker, and Claude's connector directory. Everything in the repository is ready. The items marked **(owner)** need an account owner's access.

## 1. Repository

Done: the public repository is `vobiz-ai/Vobiz-MCP-Server`, with its description, homepage, topics, MIT license, contributing guide, code of conduct, security policy, issue and PR templates, and Dependabot.

## 2. npm (`@vobiz/mcp`)

- [ ] **(owner)** Create the `vobiz` organization on npmjs.com (the `@vobiz` scope is unclaimed) and an automation token. Save the token as the `NPM_TOKEN` repository secret.
- [ ] Tag a release: bump `version` in `package.json`, `server.json` (both `version` and `packages[0].version`) and `manifest.json`, then `git tag v1.0.0 && git push --tags`. `release.yml` checks that the versions match, runs the tests and publishes with provenance.

## 3. Official MCP Registry (`io.github.vobiz-ai/vobiz-mcp`)

- [ ] `release.yml` publishes `server.json` with GitHub OIDC. The `io.github.vobiz-ai/*` namespace requires the workflow to run in a `vobiz-ai` repository.
- [ ] After the hosted connector is live, add it to `server.json`: `"remotes": [{ "type": "streamable-http", "url": "https://mcp.vobiz.ai/mcp" }]`.

## 4. Desktop extension (`.mcpb`)

- [ ] `release.yml` attaches `vobiz-mcp-vX.Y.Z.mcpb` to the GitHub release. To build one locally, run `npm run pack:mcpb`.
- [ ] Optional: sign it (`npx @anthropic-ai/mcpb@2.1.2 sign file.mcpb --cert cert.pem --key key.pem`).

## 5. Hosted connector (`https://mcp.vobiz.ai/mcp`)

- [ ] **(owner)** Deploy the Docker image ([HOSTING.md](HOSTING.md)), point DNS for `mcp.vobiz.ai` at it, and set `VOBIZ_HOSTED_URL` and `VOBIZ_HOSTED_SECRET`.
- [ ] Run the verification commands in HOSTING.md, then connect it in Claude as a custom connector and run every tool once.

## 6. Documentation page

- [ ] Once npm and the hosted connector are live, merge the docs branch `docs/vobiz-account-mcp` in the docs repository. It adds `https://www.vobiz.ai/docs/resources/vobiz-mcp`, which is the documentation URL used by the package, the registry entry and the directory listing.

## 7. Claude connector directory

Submit at <https://claude.ai/directory/manage> → **Submit new** → **MCP connector**. On Team or Enterprise plans, an Owner submits.

| Field | Value |
|---|---|
| Server URL | `https://mcp.vobiz.ai/mcp` |
| Auth | OAuth (dynamic client registration and Client ID Metadata Documents are both supported) |
| Name | Vobiz |
| One-liner (≤200) | Place and control calls, build IVRs, read call records and send SMS, MMS and RCS on your Vobiz account. |
| Description (≤2000) | Use the README introduction and tool groups. |
| Categories | Communication, Developer tools |
| Documentation | https://www.vobiz.ai/docs/resources/vobiz-mcp |
| Privacy policy | https://www.vobiz.ai/privacy (the server's own policy is in the README) |
| Support | support@vobiz.ai |
| Icon | `assets/icon.png` |
| Test account | A populated Vobiz account (numbers, call records, recordings, a SIP trunk, an application, SMS history). Share the credentials only in the reviewer field. |

**Example prompts for reviewers:**

1. "What's my Vobiz balance, and how many calls are live right now?"
2. "Show my last 10 calls with how each one ended."
3. "List my SMS numbers and preview the cost of a 200-character SMS to +14155550123."

**Already in place** (each item covered by tests):

- **Tool labels.** Every tool has a `title`. Every read tool has `readOnlyHint: true`, and every write tool has `destructiveHint: true`.
- **Tool names.** Names are 64 characters or fewer, and each operation is a separate tool (no catch-all request tool).
- **Errors.** Every error is a specific, actionable tool error; nothing comes back as a bare 500.
- **Response size.** Responses are bounded: paged lists, at most 100 items per page.
- **OAuth.** The server answers `401` with `resource_metadata`, publishes PRM with an exact `resource`, supports PKCE S256, and advertises CIMD with `none` auth. It accepts Claude's callback (`https://claude.ai/api/mcp/auth_callback`) and the loopback callbacks Claude Code uses.
- **Financial tools.** Tools that buy things (`buy_phone_number`) are not offered by the hosted connector.
- **Prompt-injection posture.** Tool descriptions contain no instructions to call unrelated tools, and third-party content is marked as data in the server instructions.

**Before submitting:** calls and SMS are billed actions. Confirm with `mcp-review@anthropic.com` whether they fall under the directory's financial-transaction policy, and decide whether the listed connector enables `VOBIZ_ENABLE_CALLS` and `VOBIZ_ENABLE_MESSAGING`. With both off, the connector is read-only plus skills.

## 8. Claude Code plugin (optional)

The [`vobiz-ai/Agent-Skills`](https://github.com/vobiz-ai/Agent-Skills) plugin already bundles the skills and the docs MCP server. To pair the listings, add the hosted connector to its `.mcp.json` (`"vobiz": { "type": "http", "url": "https://mcp.vobiz.ai/mcp" }`) and submit it as a plugin bundle from the same organization.
