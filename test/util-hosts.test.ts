import { describe, expect, it } from "vitest";
import { isPrivateHost, isPrivateHostLiteral, isPublicIp, resolvePublicHost, type HostLookup } from "../src/util.js";

const hostOf = (url: string) => new URL(url).hostname;

/** A lookup that answers from a table and records every name it was asked for. */
function fakeDns(table: Record<string, string[]>) {
  const asked: string[] = [];
  const lookup: HostLookup = async (h) => {
    asked.push(h);
    const ips = table[h];
    if (!ips) throw Object.assign(new Error(`ENOTFOUND ${h}`), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, asked };
}

describe("isPublicIp", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.10", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "::127.0.0.1",
    "not-an-ip", "", "1.2.3", "256.1.1.1",
  ])("refuses %s", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "198.20.0.1", "223.255.255.255",
    "2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])("allows %s", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });
});

describe("isPrivateHostLiteral (no DNS)", () => {
  it.each([
    "https://localhost./",
    "https://LOCALHOST/",
    "https://foo.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://metadata.google.internal/",
    "https://metadata.google.internal./",
    "https://[::ffff:127.0.0.1]/",
    "https://[::]/",
    "https://[::1]/",
    "https://169.254.169.254/",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://127.1/",
    "https://[64:ff9b::7f00:1]/",
    "https://[fec0::1]/",
    "https://[fd00::1]/",
    "https://[fe80::1]/",
    "https://[ff02::1]/",
    "https://192.0.2.1/",
    "https://224.0.0.1/",
  ])("refuses %s", (url) => {
    expect(isPrivateHostLiteral(hostOf(url))).toBe(true);
  });

  it.each(["https://fcbarcelona.com/", "https://fd-cdn.example.com/", "https://fe80.example.org/", "https://cdn.example.com/", "https://8.8.8.8/", "https://[2606:4700:4700::1111]/"])(
    "allows %s",
    (url) => {
      expect(isPrivateHostLiteral(hostOf(url))).toBe(false);
    },
  );

  it("canonicalises raw host text the way a URL parser does", () => {
    for (const h of ["127.1", "0x7f000001", "2130706433", "[::1]", "LOCALHOST.", "localhost.."]) expect(isPrivateHostLiteral(h)).toBe(true);
    expect(isPrivateHostLiteral("")).toBe(true);
  });

  it("keeps the legacy isPrivateHost for existing callers: same check, but documentation ranges pass", () => {
    for (const h of ["198.51.100.7", "192.0.2.1", "203.0.113.5", "2001:db8::1", "fcbarcelona.com"]) expect(isPrivateHost(h)).toBe(false);
    for (const h of ["198.51.100.7", "192.0.2.1", "2001:db8::1"]) expect(isPrivateHostLiteral(h)).toBe(true);
    for (const h of ["127.0.0.1", "localhost", "[::ffff:7f00:1]", "169.254.169.254", "fd00::1"]) expect(isPrivateHost(h)).toBe(true);
  });
});

describe("resolvePublicHost (DNS mocked)", () => {
  it("accepts a name only when every resolved address is public", async () => {
    const dns = fakeDns({ "cdn.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] });
    expect(await resolvePublicHost("cdn.example.com", dns.lookup)).toEqual({
      ok: true,
      addresses: [
        { address: "93.184.215.14", family: 4 },
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      ],
    });
  });

  it("refuses a name when ANY resolved address is private", async () => {
    const dns = fakeDns({
      "mixed.example.com": ["93.184.215.14", "10.0.0.7"],
      "rebind.example.com": ["127.0.0.1"],
      "v6.example.com": ["::ffff:169.254.169.254"],
      "nat64.example.com": ["64:ff9b::a9fe:a9fe"],
      "zone.example.com": ["fe80::1%en0"],
    });
    for (const h of ["mixed.example.com", "rebind.example.com", "v6.example.com", "nat64.example.com", "zone.example.com"]) {
      expect(await resolvePublicHost(h, dns.lookup)).toEqual({ ok: false, reason: "private" });
    }
  });

  it("strips a trailing dot before resolving and refuses private names without asking DNS", async () => {
    const dns = fakeDns({ "cdn.example.com": ["93.184.215.14"], localhost: ["93.184.215.14"], metadata: ["93.184.215.14"] });
    expect(await resolvePublicHost("cdn.example.com.", dns.lookup)).toMatchObject({ ok: true });
    for (const h of ["localhost.", "a.localhost", "x.local", "metadata.google.internal", "metadata"]) {
      expect(await resolvePublicHost(h, dns.lookup)).toEqual({ ok: false, reason: "private" });
    }
    expect(dns.asked).toEqual(["cdn.example.com"]);
  });

  it("takes the fast path for IP literals, bracketed IPv6 too", async () => {
    const dns = fakeDns({});
    expect(await resolvePublicHost("8.8.8.8", dns.lookup)).toEqual({ ok: true, addresses: [{ address: "8.8.8.8", family: 4 }] });
    expect(await resolvePublicHost("[2606:4700:4700::1111]", dns.lookup)).toEqual({ ok: true, addresses: [{ address: "2606:4700:4700::1111", family: 6 }] });
    for (const h of ["[::ffff:7f00:1]", "[::]", "169.254.169.254", "127.0.0.1", "[64:ff9b::7f00:1]", "[fec0::1]"]) {
      expect(await resolvePublicHost(h, dns.lookup)).toEqual({ ok: false, reason: "private" });
    }
    expect(dns.asked).toEqual([]);
  });

  it("reports names that do not resolve", async () => {
    const dns = fakeDns({ "empty.example.com": [] });
    expect(await resolvePublicHost("nx.example.com", dns.lookup)).toEqual({ ok: false, reason: "unresolvable" });
    expect(await resolvePublicHost("empty.example.com", dns.lookup)).toEqual({ ok: false, reason: "unresolvable" });
  });
});
