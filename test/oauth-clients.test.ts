import { describe, expect, it } from "vitest";
import {
  CLAUDE_CALLBACK,
  GENERIC_CLIENT_NAME,
  classifyClient,
  cleanText,
  parseTrustedClients,
  redirectUriProblem,
  sanitizeClientName,
  verifiedCimdName,
} from "../src/oauth/clients.js";
import { ConfigError } from "../src/config.js";
import { testConfig } from "./helpers.js";

const trusted = [{ host: "app.example.com", name: "Example App" }];

describe("client classification", () => {
  const cases: [string, { client_id: string; redirect_uris?: string[]; client_name?: string }, string, string][] = [
    ["Claude CIMD", { client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", redirect_uris: [CLAUDE_CALLBACK], client_name: "Evil" }, "verified", "Claude"],
    ["Claude Code CIMD", { client_id: "https://claude.ai/oauth/claude-code-client-metadata", redirect_uris: ["http://localhost/callback"] }, "verified", "Claude Code"],
    ["ChatGPT CIMD", { client_id: "https://chatgpt.com/oauth/client.json", client_name: "x" }, "verified", "ChatGPT"],
    ["ChatGPT CIMD with callback id", { client_id: "https://chatgpt.com/oauth/abc_123/client.json" }, "verified", "ChatGPT"],
    ["Codex CIMD", { client_id: "https://chatgpt.com/oauth/codex/client.json" }, "verified", "Codex"],
    ["Codex CIMD with callback id", { client_id: "https://chatgpt.com/oauth/codex/c-9/client.json" }, "verified", "Codex"],
    ["DCR on Claude's callback", { client_id: "vbzc_x", redirect_uris: [CLAUDE_CALLBACK], client_name: "Whatever" }, "verified", "Claude"],
    ["DCR on ChatGPT's callbacks", { client_id: "vbzc_x", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/abc"] }, "verified", "ChatGPT"],
    ["DCR on a trusted host", { client_id: "vbzc_x", redirect_uris: ["https://app.example.com/cb", "https://APP.example.com/cb2"], client_name: "Claude" }, "verified", "Example App"],
    ["DCR trusted host mixed with another", { client_id: "vbzc_x", redirect_uris: ["https://app.example.com/cb", "https://other.example/cb"], client_name: "Mixed" }, "unverified", "Mixed"],
    ["DCR on Claude's callback plus another", { client_id: "vbzc_x", redirect_uris: [CLAUDE_CALLBACK, "https://evil.example/cb"], client_name: "Claude" }, "unverified", GENERIC_CLIENT_NAME],
    ["loopback localhost", { client_id: "vbzc_x", redirect_uris: ["http://localhost:4567/callback"], client_name: "My CLI" }, "local", "My CLI"],
    ["loopback 127.0.0.1 and [::1]", { client_id: "vbzc_x", redirect_uris: ["http://127.0.0.1:1/cb", "http://[::1]:9/cb"] }, "local", GENERIC_CLIENT_NAME],
    ["https elsewhere", { client_id: "vbzc_x", redirect_uris: ["https://evil.example/cb"], client_name: "Totally Claude" }, "unverified", GENERIC_CLIENT_NAME],
    ["lookalike Claude callback", { client_id: "vbzc_x", redirect_uris: ["https://claude.ai.evil.example/api/mcp/auth_callback"], client_name: "Tool" }, "unverified", "Tool"],
    ["unlisted CIMD id falls back to the redirect rules", { client_id: "https://claude.ai/oauth/other", redirect_uris: [CLAUDE_CALLBACK] }, "verified", "Claude"],
  ];
  for (const [label, client, kind, name] of cases) {
    it(label, () => {
      const c = classifyClient(client, trusted);
      expect(c.kind).toBe(kind);
      expect(c.name).toBe(name);
    });
  }

  it("matches CIMD client_ids exactly", () => {
    for (const bad of [
      "https://claude.ai/oauth/mcp-oauth-client-metadata/",
      "https://claude.ai/oauth/mcp-oauth-client-metadata?x=1",
      "https://evil.claude.ai/oauth/mcp-oauth-client-metadata",
      "http://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://chatgpt.com/oauth/a/b/client.json",
      "https://chatgpt.com/oauth/client.json.evil",
      "https://claude.ai/anything",
    ]) {
      expect(verifiedCimdName(bad)).toBeUndefined();
    }
  });
});

describe("client name sanitising", () => {
  it("strips bidi and control characters, collapses whitespace and caps at 64", () => {
    expect(sanitizeClientName("  My\u202E ppA \u2066tool\u2069\u200F\n\t x ")).toBe("My ppA tool x");
    expect(sanitizeClientName("\u0007Beep\u0000")).toBe("Beep");
    expect([...sanitizeClientName("a".repeat(200))].length).toBe(64);
    expect(sanitizeClientName("")).toBe(GENERIC_CLIENT_NAME);
    expect(sanitizeClientName(undefined)).toBe(GENERIC_CLIENT_NAME);
    expect(sanitizeClientName("\u202E\u200E")).toBe(GENERIC_CLIENT_NAME);
  });
  it("refuses brand words, also disguised", () => {
    for (const n of ["Claude", "my claude helper", "Anthropic tools", "ChatGPT", "Open AI", "codex", "VOBIZ", "Cláude", "C.l.a.u.d.e", "Ch\u202EatGPT"]) {
      expect(sanitizeClientName(n)).toBe(GENERIC_CLIENT_NAME);
    }
    expect(sanitizeClientName("Acme Dialer")).toBe("Acme Dialer");
  });
  it("cleanText keeps an operator-set name but strips controls", () => {
    expect(cleanText("Example\u202E App")).toBe("Example App");
  });
});

describe("redirect URI rules", () => {
  it("accepts https and loopback http", () => {
    for (const ok of [CLAUDE_CALLBACK, "http://localhost:3333/callback", "http://127.0.0.1/callback", "http://[::1]:80/cb", "https://app.example.com/cb?x=1"]) {
      expect(redirectUriProblem(ok)).toBeUndefined();
    }
  });
  it("refuses http elsewhere, fragments, wildcards, custom schemes and credentials", () => {
    for (const bad of ["http://evil.example/cb", "https://a.example/cb#x", "https://*.example.com/cb", "myapp://callback", "javascript:alert(1)", "https://u:p@a.example/cb", "", "not a url"]) {
      expect(redirectUriProblem(bad)).toBeTruthy();
    }
  });
});

describe("VOBIZ_TRUSTED_CLIENTS", () => {
  it("parses host=name entries", () => {
    expect(parseTrustedClients(" app.example.com=Example App , Tools.Acme.io = Acme\u202E Tools")).toEqual([
      { host: "app.example.com", name: "Example App" },
      { host: "tools.acme.io", name: "Acme Tools" },
    ]);
    expect(parseTrustedClients(undefined)).toEqual([]);
  });
  it("rejects malformed entries in config", () => {
    for (const v of ["app.example.com", "=Name", "https://app.example.com=Name", "claude.ai=Claude", "bad host=X"]) {
      expect(() => testConfig({ VOBIZ_TRUSTED_CLIENTS: v })).toThrow(ConfigError);
    }
    expect(testConfig({ VOBIZ_TRUSTED_CLIENTS: "app.example.com=Example App" }).oauth.trustedClients).toEqual(trusted);
  });
});
