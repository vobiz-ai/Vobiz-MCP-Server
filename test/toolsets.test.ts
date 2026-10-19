import { describe, expect, it } from "vitest";
import { connect, mockFetch, testConfig } from "./helpers.js";
import { TOOLSET_NAMES } from "../src/server.js";

const names = async (env: Record<string, string>) => {
  const { client } = await connect(testConfig(env), mockFetch([]).impl);
  return (await client.listTools()).tools;
};

describe("toolsets and read-only mode", () => {
  it("registers every toolset by default", async () => {
    const all = await names({});
    expect(all.map((t) => t.name)).toEqual(expect.arrayContaining(["make_call", "send_message", "list_vobiz_skills"]));
  });

  it("limits tools to the chosen toolsets", async () => {
    const only = (await names({ VOBIZ_TOOLSETS: "messaging,skills" })).map((t) => t.name);
    expect(only).toContain("send_message");
    expect(only).toContain("get_vobiz_skill");
    expect(only).not.toContain("make_call");
    expect(only).not.toContain("list_sip_trunks");
  });

  it("VOBIZ_READ_ONLY keeps read-only tools only", async () => {
    const ro = await names({ VOBIZ_READ_ONLY: "true" });
    expect(ro.length).toBeGreaterThan(20);
    expect(ro.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("publishes the toolset names", () => {
    expect(TOOLSET_NAMES).toEqual(expect.arrayContaining(["calls", "messaging", "skills"]));
  });
});
