import { createServer, type AddressInfo, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedLookup, pinnedRequest } from "../src/media/fetch.js";

describe("pinnedLookup", () => {
  it("answers with the pinned address in both the single and the all: true shape, whatever the name", () => {
    const look = pinnedLookup("93.184.215.14", 4);
    const single: unknown[] = [];
    look("anything.example", { family: 0 }, (...a) => single.push(...a));
    expect(single).toEqual([null, "93.184.215.14", 4]);
    const all: unknown[] = [];
    look("anything.example", { all: true }, (...a) => all.push(...a));
    expect(all).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
    const noOpts: unknown[] = [];
    (look as (h: string, cb: (...a: unknown[]) => void) => void)("x", (...a) => noOpts.push(...a));
    expect(noOpts).toEqual([null, "93.184.215.14", 4]);
  });
});

describe("pinnedRequest (real socket, no DNS)", () => {
  let server: Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    // A bare TCP listener: it counts connections and hangs up, so the TLS handshake fails after connecting.
    server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("connects to the pinned address even for a name that has no DNS record", async () => {
    // `.invalid` never resolves (RFC 6761): reaching our listener proves DNS was not consulted.
    const url = new URL(`https://rebind-check.invalid:${port}/a.mp3`);
    await expect(pinnedRequest(url, { address: "127.0.0.1", family: 4, signal: AbortSignal.timeout(5000), headers: {} })).rejects.toBeTruthy();
    expect(connections).toBe(1);
  });

  it("refuses non-https and honours the abort signal", async () => {
    await expect(pinnedRequest(new URL("http://x.invalid/"), { address: "127.0.0.1", family: 4, signal: AbortSignal.timeout(1000), headers: {} })).rejects.toThrow("https only");
    const ac = new AbortController();
    ac.abort();
    await expect(pinnedRequest(new URL(`https://x.invalid:${port}/`), { address: "127.0.0.1", family: 4, signal: ac.signal, headers: {} })).rejects.toBeTruthy();
  });
});
