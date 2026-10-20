import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { ANTHROPIC_EGRESS_CIDRS, CidrMatcher, extractCidrs, fetchCidrList, parseCidr, parseCidrList } from "../src/oauth/cidr.js";
import { createHostedApp } from "../src/hosted.js";
import { ConfigError } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { json, mockFetch, testConfig } from "./helpers.js";

describe("CIDR matcher", () => {
  const m = new CidrMatcher(ANTHROPIC_EGRESS_CIDRS.concat(["2001:db8:10::/48", "203.0.113.7"]));

  it("matches IPv4 ranges and single hosts, IPv4-mapped IPv6 and IPv6 ranges", () => {
    for (const ip of ["160.79.104.0", "160.79.107.12", "160.79.111.255", "34.162.46.92", "::ffff:160.79.105.1", "2001:db8:10::1", "2001:db8:10:ffff::9", "203.0.113.7"]) expect(m.has(ip)).toBe(true);
    for (const ip of ["160.79.112.0", "160.79.103.255", "34.162.46.93", "2001:db8:11::1", "10.0.0.1", "::1", "", undefined, "not-an-ip"]) expect(m.has(ip)).toBe(false);
  });

  it("parses and rejects ranges", () => {
    expect(parseCidr("10.0.0.0/8")).toEqual({ address: "10.0.0.0", prefix: 8, family: "ipv4" });
    expect(parseCidr("::/0")?.family).toBe("ipv6");
    for (const bad of ["10.0.0.0/33", "10.0.0/8", "::/129", "10.0.0.0/8/1", "x/1", "10.0.0.0/-1"]) expect(parseCidr(bad)).toBeUndefined();
    expect(parseCidrList("10.0.0.0/8, 2001:db8::/32 1.2.3.4")).toHaveLength(3);
    expect(() => parseCidrList("10.0.0.0/8,nope")).toThrow(/nope/);
  });

  it("extracts ranges from a published JSON list of any shape, or plain text", () => {
    const doc = JSON.stringify({ creationTime: "x", prefixes: [{ ipv4Prefix: "23.98.142.176/28" }, { ipv6Prefix: "2603:1030::/32" }, { note: "1.2.3.4" }] });
    expect(extractCidrs(doc)).toEqual(["23.98.142.176/28", "2603:1030::/32"]);
    expect(extractCidrs("10.0.0.0/8\n192.168.0.0/16, junk")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });

  it("fetches a list over https only, with a size cap, and reports failures", async () => {
    const f = mockFetch([
      { method: "GET", path: "/ok.json", respond: () => json(200, { prefixes: [{ ipv4Prefix: "23.98.142.176/28" }] }) },
      { method: "GET", path: "/big.json", respond: () => new Response("1.2.3.0/24,".repeat(7000)) },
      { method: "GET", path: "/down.json", respond: () => "network" },
    ]);
    expect(await fetchCidrList("https://lists.example/ok.json", f.impl)).toEqual({ cidrs: ["23.98.142.176/28"] });
    expect((await fetchCidrList("http://lists.example/ok.json", f.impl)).error).toContain("https");
    expect((await fetchCidrList("https://lists.example/big.json", f.impl)).error).toContain("64 KB");
    expect((await fetchCidrList("https://lists.example/down.json", f.impl)).cidrs).toEqual([]);
    expect((await fetchCidrList("https://lists.example/missing.json", f.impl)).error).toContain("404");
  });

  it("defaults to Anthropic's ranges; an explicit value replaces them; bad values fail config", () => {
    expect(testConfig().oauth.trustedEgressCidrs).toEqual(ANTHROPIC_EGRESS_CIDRS);
    expect(testConfig({ VOBIZ_TRUSTED_EGRESS_CIDRS: "" }).oauth.trustedEgressCidrs).toEqual([]);
    expect(testConfig({ VOBIZ_TRUSTED_EGRESS_CIDRS: "10.0.0.0/8" }).oauth.trustedEgressCidrs).toEqual(["10.0.0.0/8"]);
    expect(() => testConfig({ VOBIZ_TRUSTED_EGRESS_CIDRS: "10.0.0.0/99" })).toThrow(ConfigError);
    expect(() => testConfig({ VOBIZ_TRUSTED_EGRESS_URL: "http://x.example/list" })).toThrow(ConfigError);
  });
});

describe("per-IP limits on /token and /register", () => {
  const closers: (() => void)[] = [];
  afterAll(() => closers.forEach((c) => c()));
  const start = async (trustedEgressCidrs: string[]) => {
    const app = createHostedApp({ cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined }), log: silentLogger, baseUrl: "https://mcp.example.test", secret: "s".repeat(40), trustedEgressCidrs });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    closers.push(() => srv.close());
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  };
  const hammer = async (base: string) => {
    const token: number[] = [];
    for (let i = 0; i < 51; i++) token.push((await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "vbzc_x" }) })).status);
    const reg: number[] = [];
    for (let i = 0; i < 21; i++) {
      reg.push((await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }) })).status);
    }
    return { token, reg };
  };

  it("apply to ordinary IPs", async () => {
    const { token, reg } = await hammer(await start([]));
    expect(token.at(-1)).toBe(429);
    expect(reg.at(-1)).toBe(429);
  }, 30_000);

  it("are skipped for trusted egress ranges", async () => {
    const { token, reg } = await hammer(await start(["127.0.0.0/8"]));
    expect(token).not.toContain(429);
    expect(reg).not.toContain(429);
  }, 30_000);
});
