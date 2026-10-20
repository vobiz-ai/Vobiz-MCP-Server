/**
 * Trusted egress ranges: the shared outbound IPs of hosted MCP clients (Claude, ChatGPT). Their backends call
 * /token and /register for every user from a few addresses, so the SDK's per-IP buckets on those endpoints would
 * lock every user of that client out at scale. Requests from these ranges skip those two buckets only; /authorize
 * and /oauth/login come from the user's own browser and stay limited.
 */
import { BlockList, isIP } from "node:net";

/** Anthropic's published outbound IPs for Claude (https://platform.claude.com/docs/en/api/ip-addresses). */
export const ANTHROPIC_EGRESS_CIDRS = [
  "160.79.104.0/21",
  "34.162.102.82/32",
  "34.162.136.91/32",
  "34.162.142.92/32",
  "34.162.183.95/32",
  "34.162.46.92/32",
];

/** "a.b.c.d/n" or "v6::/n" (a bare address means a single host); undefined when malformed. */
export function parseCidr(v: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | undefined {
  const [addr = "", bits, extra] = v.trim().split("/");
  if (extra !== undefined) return undefined;
  const kind = isIP(addr);
  if (!kind) return undefined;
  const max = kind === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return undefined;
  return { address: addr, prefix, family: kind === 4 ? "ipv4" : "ipv6" };
}

/** Parses a comma/whitespace-separated CIDR list; throws naming the first bad entry. */
export function parseCidrList(v: string): string[] {
  const out: string[] = [];
  for (const item of v.split(/[\s,]+/).filter(Boolean)) {
    if (!parseCidr(item)) throw new Error(`not a CIDR range: ${item.slice(0, 60)}`);
    out.push(item);
  }
  return out;
}

/** Pulls every CIDR-looking string out of a published list (JSON of any shape, or plain text). */
export function extractCidrs(text: string): string[] {
  let strings: string[] = [];
  try {
    const walk = (x: unknown): void => {
      if (typeof x === "string") strings.push(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(JSON.parse(text));
  } catch {
    strings = text.split(/[\s,]+/);
  }
  return [...new Set(strings.map((s) => s.trim()).filter((s) => s.includes("/") && parseCidr(s)))];
}

export class CidrMatcher {
  private readonly list = new BlockList();
  readonly size: number;
  constructor(cidrs: string[]) {
    let n = 0;
    for (const c of cidrs) {
      const p = parseCidr(c);
      if (!p) continue;
      this.list.addSubnet(p.address, p.prefix, p.family);
      n++;
    }
    this.size = n;
  }
  /** True when `ip` (IPv4, IPv6 or IPv4-mapped IPv6) is inside one of the ranges. */
  has(ip: string | undefined): boolean {
    if (!ip || !this.size) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    const addr = mapped ? mapped[1]! : ip;
    const kind = isIP(addr);
    if (!kind) return false;
    return this.list.check(addr, kind === 4 ? "ipv4" : "ipv6");
  }
}

/**
 * Fetches a published range list at startup (https only, 64 KB cap, 5 s timeout). Returns [] on any failure so the
 * caller keeps its built-in ranges.
 */
export async function fetchCidrList(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ cidrs: string[]; error?: string }> {
  try {
    if (new URL(url).protocol !== "https:") return { cidrs: [], error: "not an https URL" };
    const res = await fetchImpl(url, { headers: { Accept: "application/json, text/plain" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { cidrs: [], error: `status ${res.status}` };
    if (Number(res.headers.get("content-length") ?? 0) > 64 * 1024) return { cidrs: [], error: "larger than 64 KB" };
    const text = await res.text();
    if (text.length > 64 * 1024) return { cidrs: [], error: "larger than 64 KB" };
    const cidrs = extractCidrs(text);
    return cidrs.length ? { cidrs } : { cidrs: [], error: "no CIDR ranges found" };
  } catch (err) {
    return { cidrs: [], error: err instanceof Error ? err.message.slice(0, 120) : "fetch failed" };
  }
}
