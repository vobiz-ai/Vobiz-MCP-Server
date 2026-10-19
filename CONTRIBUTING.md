# Contributing to the Vobiz MCP server

Thanks for helping make the Vobiz MCP server better. Bug reports, fixes, new tools and documentation are all welcome.

## Ground rules

- **Safety first.** Any tool that spends money, contacts a real person or changes an account must:
  - be off by default behind a `VOBIZ_ENABLE_*` switch
  - require `confirm: true`, checked before any network call
  - be annotated `destructiveHint: true`
  - respect the server's rate limits and idempotency
- **No secrets in results or logs.** Redact tokens, passwords and SIP credentials. Log route templates and status codes only, never phone numbers or message text.
- **Tenant scoping.** Build every API path from the configured or signed-in account (`ctx.client.accountPath(...)`). Never accept an account ID as tool input.
- **Accurate tools.** Only wrap endpoints documented in the [Vobiz API reference](https://www.vobiz.ai/docs). Don't guess fields.
- **Clear descriptions.** Every tool needs:
  - a snake_case name of 64 characters or fewer
  - a `title`
  - a description that says what it does and when to use it
  - `readOnlyHint: true` (reads) or `destructiveHint: true` (writes)

  Spell the product **Vobiz**.

## Development setup

Requirements: Node.js 22.9+ and npm.

```bash
git clone https://github.com/vobiz-ai/Vobiz-MCP-Server.git
cd Vobiz-MCP-Server
npm ci
npm run check          # lint (tsc --noUnusedLocals), build, all tests
npm run inspector      # try tools in the MCP Inspector
```

Live tests use your own account and never place calls, send messages or buy numbers:

```bash
cp .env.example .env   # add VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN
npm run test:live
npm run test:live:hosted
```

## Adding a tool

1. Put it in the matching file under `src/tools/` (or a new file, registered as a toolset in `src/server.ts`).
2. Validate inputs with zod (strict regexes for IDs, E.164 for numbers, https or wss for URLs).
3. Throw `VobizError` with an existing error kind and an actionable message. The `handler()` wrapper turns it into an MCP tool error.
4. Add tests next to the others in `test/`. Use `mockFetch`; tests must never reach the network. The inventory tests in `test/other.test.ts` and `test/tools.test.ts` check names, annotations and confirm flags.
5. Run `npm run docs:tools` to regenerate `docs/TOOLS.md`, and update `README.md` and `CHANGELOG.md`.

Skills in `skills/` are synced from the Vobiz docs repository (`npm run skills:sync`). Propose skill changes there.

## Pull requests

- Keep each PR focused on one change. Describe the change, how you tested it, and any API behaviour you relied on.
- CI must pass: lint, build, tests on Node 22 and 24, `npm audit`, the `.mcpb` manifest check and the package dry-run.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Reporting security issues

Please do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
