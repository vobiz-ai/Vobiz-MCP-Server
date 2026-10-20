import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MediaUploads } from "../src/context.js";
import { VobizError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { createServer, type ServerOptions } from "../src/server.js";
import { AUTH_ID, OWN_NUMBER, mockFetch, ownNumberRoute, testConfig } from "./helpers.js";
import { FakeMedia } from "./fake-media.js";
import { FakeReminders } from "./fake-reminders.js";

const ME = "+919811112222";
const AUDIO_TOOLS = ["create_audio_upload_link", "import_audio_from_url", "list_audio", "delete_audio"];
const profile = { scope: "full" as const, callMeOn: ME, callFrom: OWN_NUMBER, timezone: "Asia/Kolkata" };

function uploads(available = true): MediaUploads & { minted: { authId: string; name?: string }[] } {
  const minted: { authId: string; name?: string }[] = [];
  return {
    minted,
    url: (authId, name) => {
      minted.push({ authId, ...(name ? { name } : {}) });
      return `https://mcp.example.test/upload/vbzu_test${minted.length}`;
    },
    available: async () => available,
  };
}

async function connect(opts: ServerOptions) {
  const fetch = mockFetch([ownNumberRoute]);
  const server = createServer(testConfig(), silentLogger, fetch.impl, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any> };
  };
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  return { client, call, names };
}

const setup = (o: { available?: boolean; reminders?: FakeReminders; media?: FakeMedia; readOnly?: boolean } = {}) => {
  const media = o.media ?? new FakeMedia();
  const reminders = o.reminders ?? new FakeReminders();
  const up = uploads(o.available ?? true);
  return { media, reminders, up, conn: connect({ reminders, media, mediaUploads: up, profile, ...(o.readOnly ? { readOnly: true } : {}) }) };
};

describe("audio tools registration", () => {
  it("registers nothing without a MediaService, or without reminders", async () => {
    expect(await (await connect({ reminders: new FakeReminders() })).names()).not.toEqual(expect.arrayContaining(["list_audio"]));
    const noReminders = await (await connect({ media: new FakeMedia(), mediaUploads: uploads() })).names();
    for (const n of AUDIO_TOOLS) expect(noReminders).not.toContain(n);
  });

  it("registers the four tools in the reminders toolset with the right annotations", async () => {
    const { client } = await setup().conn;
    const by = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const n of AUDIO_TOOLS) expect(by[n]).toBeDefined();
    expect(by.create_audio_upload_link!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(by.create_audio_upload_link!.description).toMatch(
      /^Vobiz: use this when the user wants their OWN audio file or recording played on a reminder or wake-up call \(e\.g\. 'use this MP3 as my alarm', 'let me record the message'\)\. Returns a one-time Vobiz upload link/,
    );
    expect(by.import_audio_from_url!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.list_audio!.annotations?.readOnlyHint).toBe(true);
    expect(by.delete_audio!.annotations).toMatchObject({ destructiveHint: true });
    expect(by.schedule_reminder_call!.inputSchema.properties).toHaveProperty("audio");
    expect(by.schedule_reminder_call!.description).toContain("pass `audio`");

    const only = await connect({ reminders: new FakeReminders(), media: new FakeMedia(), mediaUploads: uploads(), includeTools: ["list_audio"] });
    expect(await only.names()).toEqual(["list_audio"]);
    const toolsetOff = createServer(testConfig({ VOBIZ_TOOLSETS: "calls" }), silentLogger, undefined, { reminders: new FakeReminders(), media: new FakeMedia() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([toolsetOff.connect(a), c.connect(b)]);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("list_audio");
  });

  it("read-only keeps list_audio only; no upload link tool without upload minting", async () => {
    const ro = await setup({ readOnly: true }).conn;
    const names = await ro.names();
    expect(names).toContain("list_audio");
    for (const n of ["create_audio_upload_link", "import_audio_from_url", "delete_audio"]) expect(names).not.toContain(n);
    const noMint = await connect({ reminders: new FakeReminders(), media: new FakeMedia(), profile });
    expect(await noMint.names()).not.toContain("create_audio_upload_link");
    expect(await noMint.names()).toContain("import_audio_from_url");
  });
});

describe("create_audio_upload_link", () => {
  it("mints a link for the signed-in account and explains the three ways in", async () => {
    const t = setup();
    const { call } = await t.conn;
    const r = await call("create_audio_upload_link", { name: "Morning alarm" });
    expect(r.isError).toBe(false);
    expect(t.up.minted).toEqual([{ authId: AUTH_ID, name: "Morning alarm" }]);
    expect(r.data).toMatchObject({ ok: true, upload_url: "https://mcp.example.test/upload/vbzu_test1", expires_in_minutes: 15 });
    expect(r.data.how_to).toHaveLength(3);
    expect(r.data.how_to[0]).toContain("upload a file or record");
    expect(r.data.how_to[1]).toBe(
      'Or, when the user attached the file in this chat and you can run code, upload it yourself (set Content-Type to the file\'s type): curl -sS -X PUT -H "Content-Type: audio/mpeg" -H "X-Audio-Name: Morning alarm" --data-binary @<file> https://mcp.example.test/upload/vbzu_test1',
    );
    expect(r.data.how_to[2]).toContain('"use the audio Morning alarm"');

    const anon = await call("create_audio_upload_link", {});
    expect(anon.data.how_to[1]).toContain("X-Audio-Name: <name>");
    expect(t.up.minted[1]).toEqual({ authId: AUTH_ID });
    expect((await call("create_audio_upload_link", { name: "bad;name" })).isError).toBe(true);
  });

  it("is refused with a clear message while audio conversion is unavailable", async () => {
    const t = setup({ available: false });
    const { call } = await t.conn;
    for (const [tool, args] of [
      ["create_audio_upload_link", {}],
      ["import_audio_from_url", { url: "https://cdn.example.com/a.mp3", name: "A" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.data.error).toBe("not_allowed");
      expect(r.data.message).toContain("audio_url");
    }
    expect(t.up.minted).toEqual([]);
    expect(t.media.imports).toEqual([]);
  });
});

describe("import, list and delete audio", () => {
  it("imports an https link into the library and lists it", async () => {
    const t = setup();
    const { call } = await t.conn;
    const r = await call("import_audio_from_url", { url: "https://cdn.example.com/sounds/bell.mp3?sig=1", name: "Bell" });
    expect(r.isError).toBe(false);
    expect(t.media.imports).toEqual([{ authId: AUTH_ID, url: "https://cdn.example.com/sounds/bell.mp3?sig=1", name: "Bell" }]);
    expect(r.data.audio).toMatchObject({ id: "a_fake000000000001", name: "Bell", source: "url" });
    expect(r.data.note).toContain('audio: "Bell"');

    expect((await call("import_audio_from_url", { url: "http://cdn.example.com/a.mp3", name: "Plain" })).data.error).toBe("invalid_input");
    expect((await call("import_audio_from_url", { url: "https://u:p@cdn.example.com/a.mp3", name: "Creds" })).data.error).toBe("invalid_input");
    t.media.failNext = new VobizError("invalid_input", "No audio stream found in this file.");
    expect((await call("import_audio_from_url", { url: "https://cdn.example.com/page.html", name: "Page" })).data.message).toContain("No audio stream");

    const list = await call("list_audio");
    expect(list.data).toMatchObject({ ok: true, count: 1, limits: { max_files: 50, max_mb_per_file: 15, max_seconds_per_file: 300, max_uploads_per_day: 20 } });
    expect(list.data.audio[0]).toEqual({ id: "a_fake000000000001", name: "Bell", duration_sec: expect.any(Number), bytes: expect.any(Number), source: "url", created_at: expect.any(String) });
  });

  it("lists only the signed-in account's files", async () => {
    const media = new FakeMedia();
    await media.add("MA_SOMEONE1", Buffer.from("x"), { name: "Theirs", source: "upload" });
    const { call } = await setup({ media }).conn;
    expect((await call("list_audio")).data.count).toBe(0);
  });

  it("deletes by name with confirmation and says which reminders used it", async () => {
    const media = new FakeMedia();
    const reminders = new FakeReminders();
    const m = await media.add(AUTH_ID, Buffer.from("tune"), { name: "Alarm", source: "upload" });
    const { call } = await setup({ media, reminders }).conn;
    const s = await call("schedule_reminder_call", { at: "now", message: "Up", audio: "Alarm", confirm: true });
    expect(s.isError).toBe(false);

    expect((await call("delete_audio", { audio: "nope", confirm: true })).data.error).toBe("not_found");
    const ask = await call("delete_audio", { audio: "alarm", confirm: false });
    expect(ask.data.error).toBe("confirmation_required");
    expect(ask.data.message).toContain('"Alarm". 1 scheduled reminder call uses it');
    expect(media.files.size).toBe(1);
    const del = await call("delete_audio", { audio: m.id, confirm: true });
    expect(del.data).toMatchObject({ ok: true, deleted: true, reminders_using_it: 1, audio: { id: m.id, name: "Alarm" } });
    expect(media.files.size).toBe(0);
  });
});

describe("schedule_reminder_call with audio", () => {
  it("resolves the name to audioId and echoes the audio", async () => {
    const t = setup();
    const m = await t.media.add(AUTH_ID, Buffer.from("x".repeat(25)), { name: "Morning alarm", source: "upload" });
    const { call } = await t.conn;
    const ask = await call("schedule_reminder_call", { at: "now", message: "Wake up", audio: "MORNING ALARM", confirm: false });
    expect(ask.data.error).toBe("confirmation_required");
    expect(ask.data.message).toContain('(starting with the audio "Morning alarm")');
    const r = await call("schedule_reminder_call", { at: "now", message: "Wake up", audio: "MORNING ALARM", confirm: true });
    expect(r.isError).toBe(false);
    expect(t.reminders.scheduled.at(-1)!.input).toMatchObject({ audioId: m.id });
    expect(t.reminders.scheduled.at(-1)!.input.audioUrl).toBeUndefined();
    expect(r.data.audio).toEqual({ id: m.id, name: "Morning alarm", duration_sec: 2.5 });
    const byId = await call("schedule_reminder_call", { at: "now", message: "Again", audio: m.id, confirm: true });
    expect(byId.data.audio.id).toBe(m.id);
  });

  it("refuses audio together with audio_url, an unknown name, or a server without a library", async () => {
    const t = setup();
    await t.media.add(AUTH_ID, Buffer.from("x"), { name: "Bell", source: "upload" });
    const { call } = await t.conn;
    const both = await call("schedule_reminder_call", { at: "now", message: "x", audio: "Bell", audio_url: "https://cdn.example.com/a.mp3", confirm: true });
    expect(both.data).toMatchObject({ error: "invalid_input", message: expect.stringContaining("not both") });
    const missing = await call("schedule_reminder_call", { at: "now", message: "x", audio: "Gong", confirm: true });
    expect(missing.data).toMatchObject({ error: "not_found", message: expect.stringContaining("list_audio") });
    expect(t.reminders.scheduled).toHaveLength(0);

    const bare = await connect({ reminders: new FakeReminders(), profile });
    expect((await bare.call("schedule_reminder_call", { at: "now", message: "x", audio: "Bell", confirm: true })).data.error).toBe("invalid_input");
    const plain = await call("schedule_reminder_call", { at: "now", message: "x", confirm: true });
    expect(plain.data).not.toHaveProperty("audio");
  });
});
