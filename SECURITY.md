# Security policy

Please report vulnerabilities privately to **security@vobiz.ai** (or support@vobiz.ai). Do not open a public issue. Include steps to reproduce and the affected version. We acknowledge reports within 3 business days.

Supported versions: the latest minor release of `@vobiz/mcp`.

Design notes for reviewers:

- Credentials come only from the environment (local modes) or from AES-256-GCM sealed OAuth tokens (hosted mode). They are never logged.
- Every operation is scoped to the authenticated account. No tool accepts an account ID.
- Money-spending and real-world actions are off by default, need `confirm: true`, and are rate-limited and idempotent.
- Call-control URLs must be https and on an approved host (hosted mode: any public host, never a private or loopback address).
- Vobiz callbacks are verified with V3/V2 HMAC signatures, with nonce-replay protection.

Compliance: Vobiz (Ilaimitado Private Limited) is ISO/IEC 27001:2022 certified and holds a SOC 2 Type 1 report. Certificates, penetration-test reports, the Data Processing Addendum and the sub-processor list are available from the [Vobiz Trust Center](https://www.vobiz.ai/trust-center).
