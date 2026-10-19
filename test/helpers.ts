import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

export const BASE = "https://api.test.invalid";
export const AUTH_ID = "MA_TEST123";
export const OWN_NUMBER = "+919000000001";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

type Responder = (req: RecordedCall) => Response | Promise<Response> | "timeout" | "network";

export interface Route {
  method: string;
  /** Matched against url.pathname (exact) */
  path: string;
  /** Optional query match */
  query?: Record<string, string>;
  respond: Responder;
}

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export function mockFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const rec: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(rec);
    const route = routes.find(
      (r) =>
        r.method === rec.method &&
        r.path === url.pathname &&
        Object.entries(r.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v),
    );
    if (!route) return json(404, { api_id: "x", error: "not found (no mock route)" });
    const out = await route.respond(rec);
    if (out === "timeout") {
      // Simulate the client aborting: wait for the abort signal.
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (out === "network") throw new TypeError("fetch failed");
    return out as Response;
  }) as typeof fetch;
  return { impl, calls };
}

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    VOBIZ_AUTH_ID: AUTH_ID,
    VOBIZ_AUTH_TOKEN: "test-token-not-real",
    VOBIZ_BASE_URL: BASE,
    VOBIZ_TIMEOUT_MS: "1000",
    VOBIZ_ENABLE_CALLS: "true",
    VOBIZ_DEFAULT_ANSWER_URL: "https://example.com/answer.xml",
    VOBIZ_LOG_LEVEL: "silent",
    // Tests exercise the destination policy with India as the configured country (the shipped default is any country).
    VOBIZ_ALLOWED_COUNTRY_CODES: "91",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export async function connect(cfg: Config, fetchImpl: typeof fetch) {
  const server = createServer(cfg, silentLogger, fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content: { type: string; text: string }[];
    };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any>, text: res.content?.[0]?.text ?? "" };
  };
  return { client, call };
}

export const acct = (suffix: string) => `/api/v1/Account/${AUTH_ID}${suffix}`;

/** Routes make_call's pre-flight checks need: no live/queued calls and a healthy balance. */
export const capacityRoutes: Route[] = [
  { method: "GET", path: acct("/Call/"), query: { status: "live" }, respond: () => json(200, { calls: [] }) },
  { method: "GET", path: acct("/Call/"), query: { status: "queued" }, respond: () => json(200, { calls: [] }) },
  { method: "GET", path: acct("/balance/INR"), respond: () => json(200, { currency: "INR", available_balance: 1000, balance: 1000, is_postpaid: false }) },
  { method: "GET", path: acct("/balance"), respond: () => json(200, { balances: [{ currency: "INR", available_balance: 1000, balance: 1000, is_postpaid: false }] }) },
];

/** numbers?search route that reports OWN_NUMBER as an active voice number. */
export const ownNumberRoute: Route = {
  method: "GET",
  path: acct("/numbers"),
  respond: () =>
    json(200, {
      items: [{ e164: OWN_NUMBER, status: "active", voice_enabled: true, capabilities: { voice: true } }],
      page: 1,
      per_page: 25,
      total: 1,
    }),
};
