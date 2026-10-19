import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VobizClient } from "../src/client.js";
import type { ToolContext } from "../src/context.js";
import { silentLogger } from "../src/logger.js";
import { createSharedState } from "../src/server.js";
import { registerConferenceTools } from "../src/tools/conferences.js";
import { acct, json, mockFetch, testConfig, type Route } from "./helpers.js";

const ROOM = "My Conf Room";
const ROOM_PATH = acct("/Conference/My%20Conf%20Room/");
const AUDIO = "https://example.com/audio/welcome.mp3";

async function setup(routes: Route[]) {
  const m = mockFetch(routes);
  const cfg = testConfig();
  const ctx: ToolContext = { cfg, log: silentLogger, client: new VobizClient(cfg, silentLogger, m.impl), ...createSharedState(cfg), readOnly: false };
  const server = new McpServer({ name: "test-conferences", version: "0" });
  registerConferenceTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any>; content: { text: string }[] };
    return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, any>, text: res.content?.[0]?.text ?? "" };
  };
  return { client, call, calls: m.calls };
}

const accepted = (message: string, ids: unknown = ["17"]) => () => json(202, { message, member_id: ids, api_id: "a" });
const noContent = () => new Response(null, { status: 204 });

describe("conference tools: metadata", () => {
  it("registers every tool with title, description and correct hints", async () => {
    const { client } = await setup([]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "list_conferences",
        "get_conference",
        "end_conference",
        "end_all_conferences",
        "mute_conference_member",
        "unmute_conference_member",
        "deafen_conference_member",
        "undeafen_conference_member",
        "kick_conference_member",
        "hangup_conference_member",
        "play_audio_to_conference_member",
        "stop_audio_to_conference_member",
        "start_conference_recording",
        "stop_conference_recording",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(t.title).toBeTruthy();
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.description).toMatch(/Vobiz/);
      const ro = t.name === "list_conferences" || t.name === "get_conference";
      expect(t.annotations?.readOnlyHint).toBe(ro);
      if (!ro) {
        expect(t.annotations?.destructiveHint).toBe(true);
        expect(t.annotations?.openWorldHint).toBe(true);
        expect(typeof t.annotations?.idempotentHint).toBe("boolean");
      }
    }
    expect(tools.find((t) => t.name === "end_all_conferences")!.description).toMatch(/EVERY running conference/);
  });
});

describe("conference tools: reads", () => {
  it("lists conference names, treating null as empty", async () => {
    const s = await setup([{ method: "GET", path: acct("/Conference/"), respond: () => json(200, { api_id: "a", conferences: ["Sales", "Support"] }) }]);
    const r = await s.call("list_conferences");
    expect(r.data).toMatchObject({ ok: true, conferences: ["Sales", "Support"], count: 2 });
    expect(s.calls[0].method).toBe("GET");

    const e = await setup([{ method: "GET", path: acct("/Conference/"), respond: () => json(200, { api_id: "a", conferences: null }) }]);
    const er = await e.call("list_conferences");
    expect(er.data).toMatchObject({ ok: true, conferences: [], count: 0 });
    expect(er.data.note).toBeTruthy();
  });

  it("gets a room with tidy members, URL-encoding the name", async () => {
    const s = await setup([
      {
        method: "GET",
        path: ROOM_PATH,
        respond: () =>
          json(200, {
            conference_name: ROOM,
            conference_run_time: "590",
            conference_member_count: "1",
            members: [{ muted: false, member_id: "17", deaf: true, from: "+919000000001", to: "+919000000002", caller_name: "A", direction: "inbound", call_uuid: "abc-123", join_time: "12" }],
            api_id: "a",
          }),
      },
    ]);
    const r = await s.call("get_conference", { conference_name: ROOM });
    expect(r.isError).toBe(false);
    expect(s.calls[0].url.pathname).toBe(ROOM_PATH);
    expect(r.data).toMatchObject({ ok: true, details_available: true, run_time_seconds: 590, member_count: 1 });
    expect(r.data.members[0]).toEqual({
      member_id: "17",
      call_uuid: "abc-123",
      from: "+919000000001",
      to: "+919000000002",
      caller_name: "A",
      direction: "inbound",
      muted: false,
      deaf: true,
      join_time_seconds: 12,
    });
  });

  it("reports a 200 {error:failed} payload as details unavailable", async () => {
    const s = await setup([{ method: "GET", path: ROOM_PATH, respond: () => json(200, { error: "failed", api_id: "a" }) }]);
    const r = await s.call("get_conference", { conference_name: ROOM });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ ok: true, details_available: false, backend_message: "failed" });
  });

  it("maps 404 to not_found with a clear message", async () => {
    const s = await setup([{ method: "GET", path: ROOM_PATH, respond: () => json(404, { error: "conference not found", api_id: "a" }) }]);
    const r = await s.call("get_conference", { conference_name: ROOM });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("not_found");
    expect(r.data.message).toMatch(/The conference is not running/);
  });
});

describe("conference tools: room and member writes", () => {
  it("ends one room and all rooms with DELETE after confirm", async () => {
    const s = await setup([
      { method: "DELETE", path: ROOM_PATH, respond: noContent },
      { method: "DELETE", path: acct("/Conference/"), respond: noContent },
    ]);
    expect((await s.call("end_conference", { conference_name: ROOM, confirm: true })).data).toMatchObject({ ok: true, ended: true, http_status: 204 });
    expect((await s.call("end_all_conferences", { confirm: true })).data).toMatchObject({ ok: true, ended_all: true });
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`DELETE ${ROOM_PATH}`, `DELETE ${acct("/Conference/")}`]);
  });

  it("refuses confirm-gated tools without confirm: true and sends nothing", async () => {
    const s = await setup([]);
    const cases: [string, Record<string, unknown>][] = [
      ["end_conference", { conference_name: ROOM, confirm: false }],
      ["end_all_conferences", { confirm: false }],
      ["kick_conference_member", { conference_name: ROOM, member_id: "17", confirm: false }],
      ["hangup_conference_member", { conference_name: ROOM, member_id: "all", confirm: false }],
      ["start_conference_recording", { conference_name: ROOM, confirm: false }],
    ];
    for (const [name, args] of cases) {
      const r = await s.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.data.error, name).toBe("confirmation_required");
    }
    expect(s.calls).toHaveLength(0);
  });

  it("sends mute/deaf/kick/hangup/play to the right method and path", async () => {
    const m = (id: string, action = "") => acct(`/Conference/My%20Conf%20Room/Member/${id}/${action}`);
    const s = await setup([
      { method: "POST", path: m("17", "Mute/"), respond: accepted("muted") },
      { method: "DELETE", path: m("17,45", "Mute/"), respond: noContent },
      { method: "POST", path: m("all", "Deaf/"), respond: accepted("deaf", "all") },
      { method: "DELETE", path: m("17", "Deaf/"), respond: noContent },
      { method: "POST", path: m("17", "Kick/"), respond: accepted("kicked") },
      { method: "DELETE", path: m("17"), respond: noContent },
      { method: "POST", path: m("17,45,82", "Play/"), respond: accepted("play queued into conference", ["17", "45", "82"]) },
      { method: "DELETE", path: m("all", "Play/"), respond: noContent },
    ]);
    const base = { conference_name: ROOM };
    expect((await s.call("mute_conference_member", { ...base, member_id: "17" })).data).toMatchObject({ ok: true, muted: true, member_id: ["17"], backend_message: "muted", http_status: 202 });
    expect((await s.call("unmute_conference_member", { ...base, member_id: "17,45" })).data).toMatchObject({ ok: true, muted: false, member_id: ["17", "45"], http_status: 204 });
    expect((await s.call("deafen_conference_member", { ...base, member_id: "all" })).data).toMatchObject({ ok: true, deaf: true, member_id: "all" });
    expect((await s.call("undeafen_conference_member", { ...base, member_id: "17" })).data).toMatchObject({ ok: true, deaf: false });
    expect((await s.call("kick_conference_member", { ...base, member_id: "17", confirm: true })).data).toMatchObject({ ok: true, kicked: true });
    expect((await s.call("hangup_conference_member", { ...base, member_id: "17", confirm: true })).data).toMatchObject({ ok: true, hung_up: true, member_id: ["17"] });
    expect((await s.call("play_audio_to_conference_member", { ...base, member_id: "17,45,82", url: AUDIO })).data).toMatchObject({ ok: true, playing: true, member_id: ["17", "45", "82"] });
    expect((await s.call("stop_audio_to_conference_member", { ...base, member_id: "all" })).data).toMatchObject({ ok: true, playing: false, member_id: "all" });

    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `POST ${m("17", "Mute/")}`,
      `DELETE ${m("17,45", "Mute/")}`,
      `POST ${m("all", "Deaf/")}`,
      `DELETE ${m("17", "Deaf/")}`,
      `POST ${m("17", "Kick/")}`,
      `DELETE ${m("17")}`,
      `POST ${m("17,45,82", "Play/")}`,
      `DELETE ${m("all", "Play/")}`,
    ]);
    expect(s.calls[0].body).toEqual({});
    expect(s.calls[4].body).toEqual({});
    expect(s.calls[6].body).toEqual({ url: AUDIO });
    expect(s.calls[1].body).toBeUndefined();
  });

  it("maps a member 404 to not_found", async () => {
    const s = await setup([]); // no route → mock answers 404
    const r = await s.call("mute_conference_member", { conference_name: ROOM, member_id: "99" });
    expect(r.data.error).toBe("not_found");
    expect(r.data.message).toMatch(/The conference is not running, or the member is not in it/);
  });
});

describe("conference tools: recording", () => {
  it("starts with file_format (never callback_url) and stops with DELETE", async () => {
    const rec = acct("/Conference/My%20Conf%20Room/Record/");
    const s = await setup([
      { method: "POST", path: rec, respond: () => json(200, { message: "async api spawned", api_id: "a" }) },
      { method: "DELETE", path: rec, respond: noContent },
    ]);
    const r = await s.call("start_conference_recording", { conference_name: ROOM, file_format: "wav", confirm: true });
    expect(r.data).toMatchObject({ ok: true, recording: true, file_format: "wav", http_status: 200 });
    expect(s.calls[0].body).toEqual({ file_format: "wav" });
    expect((await s.call("stop_conference_recording", { conference_name: ROOM })).data).toMatchObject({ ok: true, recording: false, http_status: 204 });
    expect(s.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  });

  it("maps 404 on a room that is not running", async () => {
    const s = await setup([]);
    const r = await s.call("start_conference_recording", { conference_name: "Nope", confirm: true });
    expect(r.data.error).toBe("not_found");
    expect(r.data.message).toMatch(/The conference is not running/);
  });
});

describe("conference tools: input validation", () => {
  it("rejects names and member IDs that could alter the path, sending nothing", async () => {
    const s = await setup([]);
    for (const conference_name of ["a/b", "..", ".", "room?x=1", "room#x", "100%", "", " ", "x".repeat(129)]) {
      const r = await s.call("get_conference", { conference_name });
      expect(r.isError, conference_name).toBe(true);
    }
    for (const member_id of ["17/Kick", "abc", "17,", ",17", "ALL", "17 45", "-1", "../"]) {
      const r = await s.call("mute_conference_member", { conference_name: ROOM, member_id });
      expect(r.isError, member_id).toBe(true);
    }
    const bad = await s.call("play_audio_to_conference_member", { conference_name: ROOM, member_id: "17", url: "http://example.com/a.mp3" });
    expect(bad.isError).toBe(true);
    expect(s.calls).toHaveLength(0);
  });
});
