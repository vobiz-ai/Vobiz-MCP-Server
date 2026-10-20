/**
 * Outbound https GET for URL imports, pinned to an address that was vetted before the request.
 *
 * DNS is resolved once per hop by resolvePublicHost (every answer must be public); the connection then goes to
 * that address through a custom `lookup`, so a second, rebound DNS answer is never consulted. TLS still
 * verifies the certificate against the host name. `undici` is not a direct dependency (Node's bundled copy is
 * not importable), so this uses node:https; redirects are followed by the caller, one vetted hop at a time.
 */
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

export interface PinnedRequestOptions {
  /** Vetted address to connect to; DNS is not consulted again. */
  address: string;
  family: 4 | 6;
  signal: AbortSignal;
  headers: Record<string, string>;
}

/** One GET to `url` over a connection to `o.address`. Does not follow redirects. */
export type PinnedRequest = (url: URL, o: PinnedRequestOptions) => Promise<Response>;

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A net/tls `lookup` that always answers with the pinned address, in the single or `all: true` shape Node asks for. */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (_hostname: string, opts: unknown, cb?: LookupCb): void => {
    const done = (typeof opts === "function" ? opts : cb) as LookupCb;
    const all = !!opts && typeof opts === "object" && (opts as { all?: boolean }).all === true;
    if (all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      try {
        out.append(k, one);
      } catch {
        // header value Headers will not hold: dropped
      }
    }
  }
  return out;
}

export const pinnedRequest: PinnedRequest = (url, o) =>
  new Promise<Response>((resolve, reject) => {
    if (url.protocol !== "https:") return reject(new Error("https only"));
    const req = request({
      protocol: "https:",
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: o.headers,
      // A fresh connection per request: a pooled socket must never be reused for a different vetted address.
      agent: false,
      lookup: pinnedLookup(o.address, o.family) as never,
      signal: o.signal,
    });
    req.once("error", reject);
    req.once("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        return reject(new Error("bad status"));
      }
      const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      if (!body) res.resume();
      resolve(new Response(body, { status, headers: toHeaders(res.headers) }));
    });
    req.end();
  });
