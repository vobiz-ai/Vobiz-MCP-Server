---
name: tool-descriptions
description: Use whenever adding or editing a tool definition under src/tools (or src/skills.ts): the description, the zod input schema, the annotations or the output schema. Covers the six-dimension quality checklist, the house rules and the two checks CI runs.
---

# Tool definitions: description, schema and output contract

Glama scores every tool a client sees in `tools/list` (Tool Definition Quality Score, TDQS). The server score is
`0.7 × descriptionQuality + 0.3 × coherence`, and `descriptionQuality = 0.6 × mean + 0.4 × min` of the per-tool
scores, so one weak tool drags the whole server down. Each tool is graded on six dimensions:

| Dimension | Weight | What earns marks |
| --- | --- | --- |
| Purpose clarity | 25% | First sentence = verb + resource + scope, and how it differs from its closest sibling. |
| Usage guidelines | 20% | When to use it and when not, naming the alternative tool for the excluded case. A boundary ("to filter by user, use X") earns full marks; an ordering rule ("always call this first") does not. |
| Behavioral transparency | 20% | What annotations cannot say: what exactly changes, prerequisites (env flag, confirm gate), limits, pagination semantics, what happens on an unknown id, what is redacted. |
| Parameter semantics | 15% | Every parameter has a `.describe()`: meaning, format, origin ("from make_call"), default, constraints, interactions ("ignored unless X"). Enum values listed with their meaning. |
| Conciseness | 10% | Front-loaded, no filler, nothing the schema or the annotations already state. 2–5 dense sentences; big write tools may need more. |
| Contextual completeness | 10% | An `outputSchema` with described fields, so the description need not explain the return value. |

## Checklist for every tool you touch

1. **Purpose**: does sentence one say what it does, on which resource, and name the sibling it is *not*?
2. **Usage**: is there one "use X instead when …" boundary for each neighbouring tool (list vs get, get vs status, create vs update, the undo pair)?
3. **Behaviour**: did you state the confirm gate / env flag, the limit, the paging rule, the `not_found` case and any redaction, in words the annotations cannot carry?
4. **Parameters**: run `npm run docs:coverage`; your tools must show 100% coverage and no "Read-only" suffix.
5. **Conciseness**: delete every "Read-only." / "Read-only, no API call." and every restatement of `destructiveHint`; replace each with one concrete fact.
6. **Completeness**: add an `outputSchema` whose fields are described, for every list/get tool and every write tool whose success shape is fixed.

## House rules

- **Every parameter is described.** Shared fields in `src/util.ts` (`phoneNumber`, `callId`, `isoDate`, `idempotencyKey`) carry a default description; add a call-site `.describe()` when the local meaning is narrower (`to` vs `from`, "the live call to fork").
- **Never restate an annotation.** `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` are already structured data. "Read-only." earns nothing and costs conciseness. Never contradict them either.
- **Output schema rules.** `ok()` already returns `structuredContent`. Clients validate it on error results too, so:
  - `ok` is `z.boolean()`, never `z.literal(true)` (error results carry `ok: false`);
  - every other field is `.optional()` (and `.nullable()` where the handler can send `null`);
  - the object ends with `.passthrough()` so extra keys never fail validation;
  - nested records the server marks as untrusted are `z.record(z.string(), z.unknown())` or `z.unknown()`, with a description;
  - a bare `z.object({})` earns nothing: describe the fields;
  - if a handler has two success shapes (preview vs confirmed), cover both with optional fields or skip the schema.
- **Sibling boundaries.** Name the alternative tool for the excluded case: list vs get, get vs status/KYC, create vs update, delete vs disable, and the undo pair (schedule ↔ cancel, release ↔ cancel_number_release, assign ↔ unassign, start ↔ stop).
- **Confirm and idempotency wording.** Write "Gated by VOBIZ_ENABLE_X and confirm: true" once, say what the tool answers without `confirm` (`confirmation_required` with the summary to show the user), and describe `idempotency_key` as "repeating it returns the first result instead of acting again". Do not change confirm gates, limits or handler logic in a description pass.
- **Keep the safety wiring.** `UNTRUSTED_DESCRIPTION` / `withUntrustedNotice` stay as they are; append your sentences before them. Never mention internal infrastructure, IPs or credentials.
- **Tests.** If a test asserts an old description string, update the test to the new text rather than weakening the assertion.

## Example (from the sub-account tools)

Before:

```ts
description:
  "List the sub-accounts under this Vobiz main account: name, Auth ID (SA_...), status, KYC mode, rate limit and permissions. Credentials are redacted. " +
  PAGINATION_NOTE + // "pass page/per_page (or limit/offset)" – but this tool takes page and size
  " Read-only.",
inputSchema: {
  page: z.number().int().min(1).max(10000).optional(),                      // no description
  size: z.number().int().min(1).max(100).optional().describe("Results per page, max 100. ..."),
  active_only: z.boolean().optional().describe("true returns only active sub-accounts."),
},
// no outputSchema
```

After:

```ts
description:
  "List the sub-accounts under this Vobiz main account, one page at a time: name, Auth ID (SA_...), enabled state, KYC mode, rate limit and permissions, never credentials. " +
  "Use it to find the sub_auth_id the other sub-account tools take; for one sub-account's full record use get_sub_account, and for its KYC progress use get_sub_account_kyc_status. " +
  "Pagination is stateless: pass page and size on every call and follow pagination.next_page until has_more is false. " +
  "Needs main-account (MA_) credentials: signed in as a sub-account it fails with forbidden before any request.",
inputSchema: {
  page: z.number().int().min(1).max(10000).optional().describe("1-based page number (default 1). Take the next value from pagination.next_page."),
  size: z.number().int().min(1).max(100).optional().describe("Results per page, max 100. Defaults to the server's VOBIZ_DEFAULT_PAGE_SIZE (20)."),
  active_only: z.boolean().optional().describe("true returns only active (enabled) sub-accounts; omitted or false returns disabled ones too."),
},
outputSchema: z
  .object({
    ok: z.boolean().describe("true on success; false (with error and message) when the tool failed."),
    count: z.number().optional().describe("Number of sub-accounts in this page."),
    sub_accounts: z.array(subAccountOut).optional().describe("The sub-accounts in this page."),
    pagination: paginationOut.optional(),
    credentials_note: credentialsNote,
  })
  .passthrough(),
```

What changed: the first sentence now names both siblings; the paging sentence names the real parameters; the
"Read-only." suffix became the credential prerequisite; every parameter is described; the result is a schema.

## The two checks

Both need a build first (the npm scripts run it for you).

```bash
# Parameter coverage, undocumented params, "Read-only" suffixes, tools without outputSchema (informational, exit 0).
npm run docs:coverage            # = npm run build && node scripts/tool-definition-coverage.mjs
ONLY=list_sub_accounts,get_sub_account node scripts/tool-definition-coverage.mjs   # a subset, after a build

# Deterministic TDQS checklist against the stdio server (no model, no API key). CI runs this and it must pass.
npm run tdqs:lint                # = npm run build && npx -y mcp-tdqs lint --command "node dist/index.js"
```

`tdqs:lint` sees the stdio tool set; the hosted-only tools (reminders, audio library) appear only in the coverage
script, which registers fake services so every toolset loads. Finish with `npm run -s lint` and `npx vitest run`.
