import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIO_GONE_TEXT,
  INACTIVE_CALL_TEXT,
  PAGE_LINK_MESSAGE,
  SCRIPT_TTL_SEC,
  checkPlayUrl,
  cleanSayText,
  createCallScriptBackend,
  type CallScript,
} from "../src/callscript/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Logger } from "../src/logger.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { Sealer } from "../src/sealer.js";
import { signV3 } from "../src/webhooks.js";
import { FakeMedia } from "./fake-media.js";
import { AUTH_ID, OWN_NUMBER, acct, capacityRoutes, connect, json, mockFetch, ownNumberRoute, testConfig } from "./helpers.js";

const PUBLIC = "https://mcp.example.test";
const ME = "MA_SCRIPT1234";
const TOKEN = "script-auth-token-not-real";
const sealer = new Sealer("s".repeat(40));
const logs: string[] = [];
const log: Logger = { info: (m) => void logs.push(m), debug: (m) => void logs.push(m) };
let media: FakeMedia;
let base = "";
let close: () => void;

const backend = createCallScriptBackend({
  baseUrl: PUBLIC,
  sealer,
  // The router reads the current fake on every request through this indirection.
  media: new Proxy({} as FakeMedia, { get: (_t, k) => (typeof (media as any)[k] === "function" ? (media as any)[k].bind(media) : (media as any)[k]) }),
  log,
  signatureMode: "verify_if_present",
});

beforeAll(async () => {
  const app = express();
  app.use(backend.router);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => close());
beforeEach(() => {
  media = new FakeMedia();
  logs.length = 0;
});

const script = (s: Partial<CallScript>): CallScript => ({ authId: ME, authToken: TOKEN, loop: 1, order: "play_then_say", ...s });
const local = (u: string) => `${base}${new URL(u).pathname}`;
const answer = async (s: Partial<CallScript>, init: RequestInit = { method: "POST" }) => {
  const r = await fetch(local(backend.mint(script(s)).answerUrl), init);
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.text() };
};

describe("call script tokens", () => {
  it("mints vbzs_ answer and hangup URLs on the public base, valid 20 minutes, opaque", () => {
    const u = backend.mint(script({ say: { text: "Your table is ready" } }));
    expect(u.answerUrl).toMatch(/^https:\/\/mcp\.example\.test\/c\/vbzs_[A-Za-z0-9_-]+\/answer$/);
    const token = u.answerUrl.split("/")[4];
    expect(u.hangupUrl).toBe(`${PUBLIC}/c/${token}/hangup`);
    expect(u.answerUrl).not.toContain("table");
    expect(u.answerUrl).not.toContain(TOKEN);
    const p = sealer.open<CallScript>("scr", token)!;
    expect(p).toMatchObject({ authId: ME, say: { text: "Your table is ready" } });
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(SCRIPT_TTL_SEC - 10);
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(SCRIPT_TTL_SEC);
    expect(SCRIPT_TTL_SEC).toBe(1200);
    // Bound to its kind: never opens as a reminder answer token.
    expect(sealer.open("ans", token)).toBeUndefined();
  });

  it("strips control characters from spoken text", () => {
    expect(cleanSayText("Hello\n\tworld\u0000 !\u007f")).toBe("Hello world !");
  });

  it("validates external play links", () => {
    expect(checkPlayUrl("https://cdn.example.com/a/Track.MP3")).toBe("https://cdn.example.com/a/Track.MP3");
    expect(checkPlayUrl("https://cdn.example.com/a.wav?x=1")).toBe("https://cdn.example.com/a.wav?x=1");
    expect(() => checkPlayUrl("https://pixabay.com/music/beats-chill-123/")).toThrow(PAGE_LINK_MESSAGE);
    expect(() => checkPlayUrl("https://www.youtube.com/watch?v=abc")).toThrow(PAGE_LINK_MESSAGE);
    expect(() => checkPlayUrl("http://cdn.example.com/a.mp3")).toThrow(/https/);
    expect(() => checkPlayUrl("https://u:p@cdn.example.com/a.mp3")).toThrow(/credentials/);
    expect(() => checkPlayUrl("https://127.0.0.1/a.mp3")).toThrow(/public/);
    expect(() => checkPlayUrl("https://localhost/a.mp3")).toThrow(/public/);
    expect(() => checkPlayUrl(`https://cdn.example.com/${"a".repeat(2050)}.mp3`)).toThrow(/2048/);
  });
});

describe("GET|POST /c/:token/answer", () => {
  it("plays an external URL then hangs up, as no-store XML", async () => {
    const r = await answer({ play: { url: "https://cdn.example.com/song.mp3" } });
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/xml/);
    expect(r.cache).toBe("no-store");
    expect(r.body).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Play loop="1">https://cdn.example.com/song.mp3</Play>\n    <Hangup/>\n</Response>\n`,
    );
    expect(logs).toContain("calls: callback answer signature=absent");
  });

  it("accepts GET too", async () => {
    const r = await answer({ say: { text: "Hi" } }, { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("<Speak>Hi</Speak>");
  });

  it("speaks say-only text with language, voice and loop, escaped", async () => {
    const r = await answer({ say: { text: `Table <4> & "you"`, language: "en-IN", voice: "MAN" }, loop: 2 });
    expect(r.body).toContain(`<Speak voice="MAN" language="en-IN" loop="2">Table &lt;4&gt; &amp; &quot;you&quot;</Speak>\n    <Hangup/>`);
    expect(r.body).not.toContain("<Play");
  });

  it("orders play and say as asked, with the loop on Play", async () => {
    const both = { play: { url: "https://cdn.example.com/a.wav" }, say: { text: "Done" }, loop: 3 };
    const first = await answer({ ...both, order: "play_then_say" });
    expect(first.body).toMatch(/<Play loop="3">https:\/\/cdn\.example\.com\/a\.wav<\/Play>\n\s+<Speak>Done<\/Speak>\n\s+<Hangup\/>/);
    const second = await answer({ ...both, order: "say_then_play" });
    expect(second.body).toMatch(/<Speak>Done<\/Speak>\n\s+<Play loop="3">[^<]+<\/Play>\n\s+<Hangup\/>/);
  });

  it("with loop 0 speaks first (the audio never ends) and plays until hangup", async () => {
    const r = await answer({ play: { url: "https://cdn.example.com/a.mp3" }, say: { text: "Here it is" }, loop: 0, order: "play_then_say" });
    expect(r.body).toMatch(/<Speak>Here it is<\/Speak>\n\s+<Play loop="0">/);
  });

  it("plays a library file through a freshly minted media URL", async () => {
    const m = await media.add(ME, Buffer.from("ID3 alarm bytes"), { name: "Alarm", source: "upload" });
    const r = await answer({ play: { audioId: m.id, name: "Alarm" } });
    const url = /<Play loop="1">([^<]+)<\/Play>/.exec(r.body)?.[1];
    expect(url).toMatch(/^https:\/\/mcp\.example\.test\/media\/vbzm_[A-Za-z0-9_-]+\.wav$/);
    expect(sealer.open("med", url!.slice(`${PUBLIC}/media/`.length, -4))).toMatchObject({ authId: ME, id: m.id });
    expect(r.body).toContain("<Hangup/>");
  });

  it("says the file is gone when the library file was deleted, and still speaks the message", async () => {
    const r = await answer({ play: { audioId: "a_gone000000000000", name: "Alarm" }, say: { text: "Wake up" } });
    expect(r.body).not.toContain("<Play");
    expect(r.body).toContain(`<Speak>${AUDIO_GONE_TEXT}</Speak>\n    <Speak>Wake up</Speak>\n    <Hangup/>`);
  });

  it("never plays another account's file", async () => {
    const m = await media.add("MA_OTHER9999", Buffer.from("ID3 x"), { name: "Theirs", source: "upload" });
    const r = await answer({ play: { audioId: m.id, name: "Theirs" } });
    expect(r.body).toContain(AUDIO_GONE_TEXT);
  });

  it.each([
    ["malformed", "/c/not-a-token/answer"],
    ["forged", `/c/vbzs_${"A".repeat(60)}/answer`],
    ["wrong kind", `/c/${sealer.seal("med", { authId: ME, id: "a_x" }, 60)}/answer`],
  ])("answers a %s token with the inactive script, never a 4xx", async (_l, path) => {
    const r = await fetch(`${base}${path}`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Speak>${INACTIVE_CALL_TEXT}</Speak>\n    <Hangup/>\n</Response>\n`);
  });

  it("answers an expired token with the inactive script", async () => {
    const t = sealer.seal("scr", { ...script({ say: { text: "x" } }) }, -1);
    const r = await fetch(`${base}/c/${t}/answer`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(INACTIVE_CALL_TEXT);
  });

  it("refuses other methods with 405", async () => {
    const u = local(backend.mint(script({ say: { text: "x" } })).answerUrl);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await fetch(u, { method });
      expect(r.status).toBe(405);
    }
  });

  it("verifies signatures with the sealed Auth Token and rejects bad or replayed ones", async () => {
    const u = backend.mint(script({ say: { text: "x" } })).answerUrl;
    const sign = (tok: string, n: string) => ({ "X-Vobiz-Signature-V3": signV3(tok, u, n), "X-Vobiz-Signature-V3-Nonce": n });
    expect((await fetch(local(u), { method: "POST", headers: sign(TOKEN, "n1") })).status).toBe(200);
    expect(logs).toContain("calls: callback answer signature=valid");
    expect((await fetch(local(u), { method: "POST", headers: sign(TOKEN, "n1") })).status).toBe(403);
    expect((await fetch(local(u), { method: "POST", headers: sign("wrong", "n2") })).status).toBe(403);
    expect(logs).toContain("calls: callback answer signature=invalid");
  });

  it("requires a signature in require mode", async () => {
    const strict = createCallScriptBackend({ baseUrl: PUBLIC, sealer, log, signatureMode: "require" });
    const app = express().use(strict.router);
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    try {
      const u = strict.mint(script({ say: { text: "x" } })).answerUrl;
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${new URL(u).pathname}`, { method: "POST" });
      expect(r.status).toBe(403);
    } finally {
      srv.close();
    }
  });
});

describe("POST /c/:token/hangup", () => {
  it("acknowledges and logs cause and duration only", async () => {
    const u = backend.mint(script({ say: { text: "Secret text" } })).hangupUrl;
    const r = await fetch(local(u), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ HangupCause: "NORMAL_CLEARING", BillDuration: "42", From: "+919812345678", To: "+919000000001" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(logs).toContain("calls: callback hangup signature=absent");
    expect(logs).toContain("calls: script hangup cause=NORMAL_CLEARING duration=42");
    expect(logs.join("\n")).not.toMatch(/9812345678|Secret|vbzs_/);
  });

  it("falls back to HangupCauseName and Duration, and sanitises them", async () => {
    const u = backend.mint(script({ say: { text: "x" } })).hangupUrl;
    await fetch(local(u), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ HangupCauseName: "No Answer\nX", Duration: 0 }) });
    expect(logs).toContain("calls: script hangup cause=No_Answer_X duration=0");
  });

  it("answers 200 for an invalid token and 405 for GET", async () => {
    expect((await fetch(`${base}/c/nope/hangup`, { method: "POST" })).status).toBe(200);
    const u = local(backend.mint(script({ say: { text: "x" } })).hangupUrl);
    const g = await fetch(u);
    expect(g.status).toBe(405);
    expect(g.headers.get("allow")).toBe("POST");
  });

  it("maps a malformed body to 400, never 500", async () => {
    const u = local(backend.mint(script({ say: { text: "x" } })).hangupUrl);
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    expect(r.status).toBe(400);
  });
});

// ── make_call say / play ─────────────────────────────────────────

const DEST = "+919812345678";
const UUID = "5a9fd4a0-3d4c-11ef-bef9-0242ac110005";
const base3 = { to: DEST, from: OWN_NUMBER, confirm: true };

async function mcp(o: { scripts?: boolean; withMedia?: boolean; env?: Record<string, string | undefined> } = {}) {
  const m = mockFetch([
    ownNumberRoute,
    { method: "POST", path: acct("/Call/"), respond: () => json(201, { api_id: "api-1", message: "call queued", request_uuid: UUID }) },
    ...capacityRoutes,
  ]);
  const lib = new FakeMedia();
  const cfg = testConfig(o.env ?? {});
  const server = createServer(cfg, silentLogger, m.impl, {
    ...(o.scripts === false ? {} : { callScripts: backend }),
    ...(o.withMedia === false ? {} : { media: lib }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) => {
    const res = (await client.callTool({ name: "make_call", arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any> };
  };
  const posts = () => m.calls.filter((c) => c.method === "POST" && c.url.pathname === acct("/Call/"));
  return { call, posts, lib };
}

const tokenOf = (u: string) => new URL(u).pathname.split("/")[2];

describe("make_call say / play", () => {
  it("say: posts our answer and hangup URLs and reports the script", async () => {
    const { call, posts } = await mcp();
    const r = await call({ ...base3, say: "Your table is ready", language: "en-IN", voice: "MAN" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ accepted: true, request_uuid: UUID, script: { say: true, loop: 1 } });
    expect(r.data.script).not.toHaveProperty("play");
    expect(r.data.how_to).toMatch(/speaks the text, then hangs up automatically/);
    const body = posts()[0].body as Record<string, string>;
    expect(body.answer_url).toMatch(/^https:\/\/mcp\.example\.test\/c\/vbzs_[A-Za-z0-9_-]+\/answer$/);
    expect(body.hangup_url).toBe(body.answer_url.replace(/answer$/, "hangup"));
    expect(body.answer_method).toBe("POST");
    const s = sealer.open<CallScript>("scr", tokenOf(body.answer_url))!;
    expect(s).toMatchObject({ authId: AUTH_ID, say: { text: "Your table is ready", language: "en-IN", voice: "MAN" }, loop: 1 });
    // The served XML is the script.
    const x = await (await fetch(local(body.answer_url), { method: "POST" })).text();
    expect(x).toContain(`<Speak voice="MAN" language="en-IN">Your table is ready</Speak>`);
  });

  it("play URL: validated and played; the model's own hangup_url wins", async () => {
    const { call, posts } = await mcp({ env: { VOBIZ_ALLOWED_URL_HOSTS: "hooks.example.com" } });
    const r = await call({ ...base3, play: "https://cdn.example.com/music/track.MP3", loop: 2, hangup_url: "https://hooks.example.com/h" });
    expect(r.isError).toBe(false);
    expect(r.data.script).toEqual({ say: false, play: "url", loop: 2 });
    const body = posts()[0].body as Record<string, string>;
    expect(body.hangup_url).toBe("https://hooks.example.com/h");
    expect(sealer.open<CallScript>("scr", tokenOf(body.answer_url))!.play).toEqual({ url: "https://cdn.example.com/music/track.MP3" });
  });

  it("play from the library by name: the script holds the file id", async () => {
    const { call, posts, lib } = await mcp();
    const m = await lib.add(AUTH_ID, Buffer.from("ID3 alarm"), { name: "My alarm", source: "upload" });
    const r = await call({ ...base3, play: "my ALARM", say: "Wake up", order: "say_then_play" });
    expect(r.isError).toBe(false);
    expect(r.data.script).toEqual({ say: true, play: "library:My alarm", loop: 1, order: "say_then_play" });
    const s = sealer.open<CallScript>("scr", tokenOf((posts()[0].body as Record<string, string>).answer_url))!;
    expect(s.play).toEqual({ audioId: m.id, name: "My alarm" });
    expect(s.order).toBe("say_then_play");
  });

  it("unknown library name: not_found listing the library, no call placed", async () => {
    const { call, posts, lib } = await mcp();
    await lib.add(AUTH_ID, Buffer.from("ID3 a"), { name: "Alarm", source: "upload" });
    await lib.add(AUTH_ID, Buffer.from("ID3 b"), { name: "Jingle", source: "upload" });
    const r = await call({ ...base3, play: "Beethoven" });
    expect(r.data.error).toBe("not_found");
    expect(r.data.message).toMatch(/"Jingle", "Alarm"/);
    expect(posts()).toHaveLength(0);
  });

  it.each(["https://pixabay.com/music/beats-chill-123/", "https://open.spotify.com/track/abc", "https://soundcloud.com/a/b"])(
    "rejects the page link %s with the precise message",
    async (play) => {
      const { call, posts } = await mcp();
      const r = await call({ ...base3, play });
      expect(r.data.error).toBe("invalid_input");
      expect(r.data.message).toBe(PAGE_LINK_MESSAGE);
      expect(posts()).toHaveLength(0);
    },
  );

  it("refuses say/play together with answer_url", async () => {
    const { call, posts } = await mcp();
    const r = await call({ ...base3, say: "Hi", answer_url: "https://example.com/answer.xml" });
    expect(r.data.error).toBe("invalid_input");
    expect(r.data.message).toMatch(/cannot be combined with `answer_url`/);
    expect(posts()).toHaveLength(0);
  });

  it("needs content: no answer_url, say or play and no default answer URL", async () => {
    const { call, posts } = await mcp({ env: { VOBIZ_DEFAULT_ANSWER_URL: undefined } });
    const r = await call(base3);
    expect(r.data.error).toBe("invalid_input");
    expect(r.data.message).toMatch(/`say`.*`play`.*`answer_url`/);
    expect(posts()).toHaveLength(0);
  });

  it("refuses loop/order/language without say or play", async () => {
    const { call } = await mcp();
    expect((await call({ ...base3, loop: 3 })).data.error).toBe("invalid_input");
    expect((await call({ ...base3, play: "https://cdn.example.com/a.mp3", voice: "MAN" })).data.message).toMatch(/apply to `say`/);
  });

  it("strips control characters from say and rejects empty text", async () => {
    const { call, posts } = await mcp();
    expect((await call({ ...base3, say: "\n\t" })).data.error).toBe("invalid_input");
    const r = await call({ ...base3, say: "Line one\nLine two", idempotency_key: "say-ctl-0001" });
    expect(r.isError).toBe(false);
    expect(sealer.open<CallScript>("scr", tokenOf((posts()[0].body as Record<string, string>).answer_url))!.say!.text).toBe("Line one Line two");
  });

  it("without the call-script backend (stdio / plain HTTP), say/play is invalid_input", async () => {
    const { call, posts } = await mcp({ scripts: false });
    const r = await call({ ...base3, say: "Hi" });
    expect(r.data.error).toBe("invalid_input");
    expect(r.data.message).toMatch(/hosted Vobiz connector.*VOBIZ_PUBLIC_URL/);
    expect(posts()).toHaveLength(0);
  });

  it("an identical say call inside the duplicate window is blocked (stable fingerprint)", async () => {
    const { call, posts } = await mcp();
    expect((await call({ ...base3, say: "Same" })).isError).toBe(false);
    expect((await call({ ...base3, say: "Same" })).data.error).toBe("duplicate_blocked");
    expect((await call({ ...base3, say: "Different" })).isError).toBe(false);
    expect(posts()).toHaveLength(2);
  });

  it("flags the placeholder answer URL when nothing is given", async () => {
    const { call, posts } = await mcp({ env: { VOBIZ_DEFAULT_ANSWER_URL: `${PUBLIC}/answer` } });
    const r = await call(base3);
    expect(r.isError).toBe(false);
    expect(r.data.script).toEqual({ placeholder: true });
    expect(r.data.how_to).toMatch(/placeholder.*short greeting.*`say`/);
    expect((posts()[0].body as Record<string, string>).answer_url).toBe(`${PUBLIC}/answer`);
  });

  it("leaves a caller's own answer_url untouched", async () => {
    const { call, posts } = await mcp();
    const r = await call({ ...base3, answer_url: "https://example.com/answer.xml" });
    expect(r.isError).toBe(false);
    expect(r.data).not.toHaveProperty("script");
    expect(posts()[0].body).not.toHaveProperty("hangup_url");
  });

  it("describes say/play first in the tool description", async () => {
    const { client } = await connect(testConfig(), mockFetch([]).impl);
    const t = (await client.listTools()).tools.find((x) => x.name === "make_call")!;
    expect(t.description).toMatch(/^Place ONE outbound call[^.]*\);[^.]*`say`.*`play`.*simplest way/);
    expect(t.description).toMatch(/placeholder greeting/);
    expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["say", "play", "loop", "order", "language", "voice"]));
  });
});

describe("hosted connector wiring", () => {
  it("mounts /c/:token routes when call scripts are set, and keeps the /answer placeholder unchanged", async () => {
    const { createHostedApp } = await import("../src/hosted.js");
    const app = createHostedApp({
      cfg: testConfig({ VOBIZ_AUTH_ID: undefined, VOBIZ_AUTH_TOKEN: undefined }),
      log: silentLogger,
      baseUrl: PUBLIC,
      secret: "s".repeat(40),
      callScripts: backend,
    });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const a = await fetch(`${u}${new URL(backend.mint(script({ say: { text: "Mounted" } })).answerUrl).pathname}`, { method: "POST" });
      expect(await a.text()).toContain("<Speak>Mounted</Speak>");
      expect(await (await fetch(`${u}/c/nope/answer`, { method: "POST" })).text()).toContain(INACTIVE_CALL_TEXT);
      expect(await (await fetch(`${u}/answer`, { method: "POST" })).text()).toContain("<Speak>Hello from Vobiz.</Speak>");
    } finally {
      srv.close();
    }
  });
});
