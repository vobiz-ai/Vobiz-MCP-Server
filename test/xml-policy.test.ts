import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { silentLogger } from "../src/logger.js";
import { assertDestinationAllowed } from "../src/policy.js";
import { createServer, createSharedState } from "../src/server.js";
import { assertAllowedUrl } from "../src/util.js";
import { VobizError } from "../src/errors.js";
import { buildResponseXml } from "../src/xml.js";
import { mockFetch, testConfig } from "./helpers.js";

const env = { VOBIZ_PUBLIC_URL: "https://ops.example.net", VOBIZ_BLOCKED_PREFIXES: "91900" };
const BLOCKED = "+919001234567";
const FINE = "+919812345678";

async function hostedServer() {
  const cfg = testConfig(env);
  const m = mockFetch([]);
  const server = createServer(cfg, silentLogger, m.impl, { shared: createSharedState(cfg, true) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!r.isError, data: r.structuredContent ?? {} };
  };
  return { call, fetches: m.calls };
}

describe("server-built <Dial> respects the destination policy", () => {
  const cfg = testConfig(env);
  const o = { checkUrl: (u: string, f: string) => assertAllowedUrl(cfg, u, f), checkDestination: (n: string) => assertDestinationAllowed(cfg, n) };

  it("buildResponseXml refuses a blocked prefix and a disallowed country", () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof VobizError ? e.kind : "other";
      }
      return "none";
    };
    expect(err(() => buildResponseXml([{ type: "dial", number: BLOCKED }], o))).toBe("not_allowed");
    expect(err(() => buildResponseXml([{ type: "dial", number: "+14155550123" }], o))).toBe("not_allowed");
    expect(buildResponseXml([{ type: "dial", number: FINE }], o)).toContain(`<Number>${FINE}</Number>`);
  });

  it("generate_answer_xml refuses a blocked dial number (hosted and not)", async () => {
    const { call } = await hostedServer();
    for (const host of [false, true]) {
      const r = await call("generate_answer_xml", { actions: [{ type: "dial", number: BLOCKED }], host });
      expect(r.isError).toBe(true);
      expect(r.data.error).toBe("not_allowed");
    }
    const ok = await call("generate_answer_xml", { actions: [{ type: "dial", number: FINE }] });
    expect(ok.isError).toBe(false);
  });

  it("gather_dtmf refuses a blocked number in `then` before creating a flow or moving a call", async () => {
    const { call, fetches } = await hostedServer();
    const r = await call("gather_dtmf", { prompt_text: "Press 1", then: [{ type: "dial", number: BLOCKED }] });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("not_allowed");
    expect(fetches).toHaveLength(0);
  });
});
