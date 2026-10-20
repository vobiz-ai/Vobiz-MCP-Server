import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VobizError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import { createMediaRouter, mintMediaUrl, mintUploadUrl } from "../src/media/router.js";
import { Sealer } from "../src/sealer.js";
import { FakeMedia } from "./fake-media.js";
import { testConfig } from "./helpers.js";

const PUBLIC = "https://mcp.example.test";
const ME = "MA_AUDIO1234";
const sealer = new Sealer("m".repeat(40));
const logs: string[] = [];
const log: Logger = { info: (m) => void logs.push(m), debug: (m) => void logs.push(m) };
let media: FakeMedia;
let base = "";
let close: () => void;

beforeAll(async () => {
  const app = express();
  // The router reads the current fake on every request through this indirection.
  const proxy = new Proxy({} as FakeMedia, { get: (_t, k) => (typeof (media as any)[k] === "function" ? (media as any)[k].bind(media) : (media as any)[k]) });
  media = new FakeMedia({ maxInputBytes: 4096 });
  app.use(createMediaRouter(proxy, { baseUrl: PUBLIC, sealer, log, links: testConfig().links }));
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => close());
beforeEach(() => {
  media = new FakeMedia({ maxInputBytes: 4096 });
  logs.length = 0;
});

/** Local path of a minted upload link (the router is mounted at the root, like the hosted app). */
const uploadPath = (name?: string, authId = ME) => new URL(mintUploadUrl(sealer, PUBLIC, authId, name)).pathname;
const put = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "PUT", body, headers: { "Content-Type": "audio/mpeg", ...headers } });
const audio = (s = "ID3 some mp3 bytes") => Buffer.from(s);

describe("upload links", () => {
  it("mints sealed upl and med tokens with the right payloads and lifetimes", () => {
    const u = new URL(mintUploadUrl(sealer, `${PUBLIC}/`, ME, "Morning alarm"));
    expect(u.origin).toBe(PUBLIC);
    const token = u.pathname.replace("/upload/", "");
    expect(token).toMatch(/^vbzu_/);
    const p = sealer.open<{ authId: string; jti: string; name: string; exp: number }>("upl", token)!;
    expect(p).toMatchObject({ authId: ME, name: "Morning alarm" });
    expect(p.jti).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(890);
    expect(p.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
    expect(sealer.open("med", token)).toBeUndefined();

    const m = mintMediaUrl(sealer, PUBLIC, ME, "a_x123");
    expect(m).toMatch(/^https:\/\/mcp\.example\.test\/media\/vbzm_[A-Za-z0-9_-]+\.wav$/);
    const mp = sealer.open<{ authId: string; id: string; exp: number }>("med", m.slice(`${PUBLIC}/media/`.length, -4))!;
    expect(mp).toMatchObject({ authId: ME, id: "a_x123" });
    expect(mp.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(1190);
    expect(mp.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1200);
  });
});

describe("GET /upload/:token", () => {
  it("serves the branded page with a per-response script nonce and the suggested name", async () => {
    const path = uploadPath("Morning alarm");
    const r = await fetch(`${base}${path}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("permissions-policy")).toContain("microphone=(self)");
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await r.text();
    expect(html).toContain("Add audio for your reminder calls");
    expect(html).toContain('id="name" name="name" type="text" maxlength="80" value="Morning alarm"');
    expect(html).toContain('accept="audio/*"');
    expect(html).toContain('id="rec">Record</button>');
    expect(html).toContain('data-max="4096" data-cap="300"');
    expect(html).toContain("<progress");
    expect(html).toContain("IBM+Plex+Sans");
    expect(html).toContain("#E83C00");
    expect(html).toContain("MediaRecorder");
    expect(html).toContain('"X-Audio-Name"');
    expect(html).toContain("use the audio ");
    // Every script carries the nonce; nothing is loaded from elsewhere.
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
    expect(scripts).toEqual([` nonce="${nonce}"`]);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain(path.slice("/upload/".length));
    const again = await fetch(`${base}${path}`);
    expect(/nonce-([^']+)/.exec(again.headers.get("content-security-policy")!)![1]).not.toBe(nonce);
  });

  it("ships page script that parses", async () => {
    const html = await (await fetch(`${base}${uploadPath()}`)).text();
    const js = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain('x.open("PUT",location.pathname)');
  });

  it("leaves the name empty when the suggestion breaks the naming rule", async () => {
    const html = await (await fetch(`${base}${uploadPath('<img src=x onerror=alert(1)>')}`)).text();
    expect(html).toContain('maxlength="80" value=""');
    expect(html).not.toContain("<img src=x");
  });

  it("answers 410 for forged, expired, wrong-kind and used links", async () => {
    const expired = `/upload/${sealer.seal("upl", { authId: ME, jti: "j1" }, -1)}`;
    const wrongKind = `/upload/${sealer.seal("med", { authId: ME, jti: "j2" }, 600)}`;
    const forged = `/upload/vbzu_${"A".repeat(60)}`;
    for (const p of [expired, wrongKind, forged, "/upload/nope"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(410);
      expect(await r.text()).toContain("This upload link has expired");
    }
    const path = uploadPath();
    expect((await put(path, audio(), { "X-Audio-Name": "Alarm" })).status).toBe(201);
    expect((await fetch(`${base}${path}`)).status).toBe(410);
  });
});

describe("PUT /upload/:token", () => {
  it("saves the raw body under the name and returns 201 with the audio summary", async () => {
    const r = await put(uploadPath(), audio(), { "X-Audio-Name": encodeURIComponent("Morning alarm (v2)"), "X-File-Name": encodeURIComponent("C:\\Users\\me\\alarm.mp3") });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: "a_fake000000000001", name: "Morning alarm (v2)", duration_sec: 1.8, bytes: 22 });
    expect(media.added).toEqual([{ authId: ME, bytes: 18, name: "Morning alarm (v2)", source: "upload", origin: "alarm.mp3" }]);
    expect(logs).toEqual(["media: upload saved"]);
  });

  it("accepts ?name= and any content type (curl from a code sandbox)", async () => {
    const r = await fetch(`${base}${uploadPath()}?name=Gym%20bell`, { method: "PUT", body: audio(), headers: { "Content-Type": "application/octet-stream" } });
    expect(r.status).toBe(201);
    expect((await r.json()).name).toBe("Gym bell");
    const noType = await fetch(`${base}${uploadPath()}?name=Raw`, { method: "PUT", body: new Blob([audio()]) });
    expect(noType.status).toBe(201);
  });

  it("is one-time: a second upload with the same link gets 410", async () => {
    const path = uploadPath();
    expect((await put(path, audio(), { "X-Audio-Name": "One" })).status).toBe(201);
    const again = await put(path, audio(), { "X-Audio-Name": "Two" });
    expect(again.status).toBe(410);
    expect((await again.json()).error).toBe("link_expired");
    expect(media.added.map((a) => a.name)).toEqual(["One"]);
  });

  it("lets only one of two concurrent uploads with one link land", async () => {
    media.delayMs = 50;
    const path = uploadPath();
    const [a, b] = await Promise.all([put(path, audio(), { "X-Audio-Name": "First" }), put(path, audio(), { "X-Audio-Name": "Second" })]);
    expect([a.status, b.status].sort()).toEqual([201, 410]);
    expect(media.added).toHaveLength(1);
  });

  it("answers 400 for a missing or bad name, and the link still works afterwards", async () => {
    const path = uploadPath();
    expect((await put(path, audio())).status).toBe(400);
    const bad = await put(path, audio(), { "X-Audio-Name": "semi;colon" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toContain("Give the audio a name");
    expect((await put(path, audio(), { "X-Audio-Name": "x".repeat(81) })).status).toBe(400);
    expect((await put(path, audio(), { "X-Audio-Name": "Fine name" })).status).toBe(201);
  });

  it("answers 400 for an empty body or a duplicate name", async () => {
    expect((await put(uploadPath(), null, { "X-Audio-Name": "Empty" })).status).toBe(400);
    expect((await put(uploadPath(), audio(), { "X-Audio-Name": "Alarm" })).status).toBe(201);
    const dup = await put(uploadPath(), audio(), { "X-Audio-Name": "ALARM" });
    expect(dup.status).toBe(400);
    expect((await dup.json()).message).toContain("already exists");
  });

  it("answers 413 over the size limit without using up the link", async () => {
    const path = uploadPath();
    const big = await put(path, Buffer.alloc(5000, 1), { "X-Audio-Name": "Big" });
    expect(big.status).toBe(413);
    expect((await big.json()).message).toContain("larger than");
    expect(media.added).toEqual([]);
    expect((await put(path, audio(), { "X-Audio-Name": "Small" })).status).toBe(201);
  });

  it("answers 415 when there is no audio and 400 when it is too long", async () => {
    const r = await put(uploadPath(), audio("NOAUDIO <html>"), { "X-Audio-Name": "Page" });
    expect(r.status).toBe(415);
    expect(await r.json()).toEqual({ error: "invalid_input", message: "No audio stream found in this file." });
    const long = await put(uploadPath(), audio("TOOLONG"), { "X-Audio-Name": "Long" });
    expect(long.status).toBe(400);
    expect((await long.json()).message).toContain("longer than 300 seconds");
    expect(logs).toEqual(["media: upload refused (invalid_input)", "media: upload refused (invalid_input)"]);
  });

  it("maps limits to 403/429 and unexpected failures to 503 without details, never 500", async () => {
    media.failNext = new VobizError("not_allowed", "This account already has 50 audio files (limit 50). Delete one first.");
    expect((await put(uploadPath(), audio(), { "X-Audio-Name": "A" })).status).toBe(403);
    media.failNext = new VobizError("rate_limited", "At most 20 uploads a day.");
    expect((await put(uploadPath(), audio(), { "X-Audio-Name": "A" })).status).toBe(429);
    media.failNext = new Error("ENOSPC /var/secret/path");
    const r = await put(uploadPath(), audio(), { "X-Audio-Name": "A" });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("ENOSPC");
    expect(logs.at(-1)).toBe("media: upload refused (internal_error)");
  });

  it("burns the link on a failed attempt: one link = one attempt", async () => {
    const path = uploadPath();
    media.failNext = new VobizError("invalid_input", "No audio stream found in this file.");
    expect((await put(path, audio(), { "X-Audio-Name": "First" })).status).toBe(415);
    const again = await put(path, audio(), { "X-Audio-Name": "Second" });
    expect(again.status).toBe(410);
    expect((await again.json()).error).toBe("link_expired");
    expect(media.added).toEqual([]);
    expect((await fetch(`${base}${path}`)).status).toBe(410);
  });

  it("refuses an expired link before reading the body", async () => {
    const r = await put(`/upload/${sealer.seal("upl", { authId: ME, jti: "old" }, -1)}`, audio(), { "X-Audio-Name": "Late" });
    expect(r.status).toBe(410);
    expect(media.added).toEqual([]);
  });

  it("never logs tokens", async () => {
    await put(uploadPath(), audio(), { "X-Audio-Name": "Quiet" });
    await put(uploadPath(), audio("NOAUDIO"), { "X-Audio-Name": "Loud" });
    expect(logs.join("\n")).not.toMatch(/vbz[um]_/);
  });
});

describe("GET|HEAD /media/:token", () => {
  const mediaPath = (authId: string, id: string) => new URL(mintMediaUrl(sealer, PUBLIC, authId, id)).pathname;

  it("streams the WAV with private, no-store caching, with or without the .wav suffix", async () => {
    const meta = await media.add(ME, audio("hello"), { name: "Hello", source: "upload" });
    const path = mediaPath(ME, meta.id);
    for (const p of [path, path.replace(/\.wav$/, "")]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/wav");
      expect(r.headers.get("content-length")).toBe(String(meta.bytes));
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("RIFFhello");
    }
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("audio/wav");
    expect(head.headers.get("content-length")).toBe(String(meta.bytes));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 404 with no body for unknown, expired, forged, wrong-kind or other-account tokens", async () => {
    const meta = await media.add(ME, audio(), { name: "Mine", source: "upload" });
    const cases = [
      mediaPath(ME, "a_missing"),
      mediaPath("MA_SOMEONE1", meta.id),
      `/media/${sealer.seal("med", { authId: ME, id: meta.id }, -1)}`,
      `/media/${sealer.seal("upl", { authId: ME, id: meta.id }, 600)}`,
      `/media/vbzm_${"B".repeat(60)}`,
      "/media/x",
    ];
    for (const p of cases) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
    }
  });

  it("answers 503 when storage fails", async () => {
    media.failNext = new Error("storage down");
    const r = await fetch(`${base}${mediaPath(ME, "a_any")}`);
    expect(r.status).toBe(503);
    expect(logs).toEqual(["media: open failed (internal_error)"]);
  });
});
