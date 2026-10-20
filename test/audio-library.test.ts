import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VobizError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import {
  DEFAULT_AUDIO_LIMITS,
  FfmpegProcessor,
  GcsMediaStore,
  LocalDiskMediaStore,
  createMediaBackend,
  createMediaService,
  normalizeAudioName,
  wavDurationSec,
  type AudioLimits,
  type AudioMeta,
  type AudioProcessor,
  type GcsBucketLike,
  type GcsFileLike,
} from "../src/media/index.js";

const AUTH = "MA_TESTAUDIO1";
const OTHER = "MA_TESTAUDIO2";
const HASH = createHash("sha256").update(AUTH).digest("hex").slice(0, 16);
const T0 = new Date("2026-10-20T10:00:00.000Z");

function meta(over: Partial<AudioMeta> = {}): AudioMeta {
  return { id: "a_one", authId: AUTH, name: "Alarm", durationSec: 2, bytes: 4, contentType: "audio/wav", source: "upload", createdAt: T0.toISOString(), ...over };
}

async function readAll(s: NodeJS.ReadableStream): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof VobizError ? { kind: e.kind, status: e.status, message: e.message } : { kind: "other", message: String(e) };
  }
  return { kind: "resolved" };
};

// ── Stores ─────────────────────────────────────────────────────

describe("LocalDiskMediaStore", () => {
  let dir: string;
  let store: LocalDiskMediaStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vobiz-media-test-"));
    store = new LocalDiskMediaStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("stores the WAV and a sidecar under accounts/<sha256(authId)[:16]>/, never the Auth ID or a token", async () => {
    await store.put({ ...meta(), authToken: "secret-token" } as AudioMeta, Buffer.from("RIFF"));
    const folder = join(dir, "accounts", HASH);
    expect((await readdir(folder)).sort()).toEqual(["a_one.json", "a_one.wav"]);
    const sidecar = await readFile(join(folder, "a_one.json"), "utf8");
    expect(sidecar).not.toContain("secret-token");
    expect(JSON.parse(sidecar)).toEqual(meta());
    expect(await readFile(join(folder, "a_one.wav"), "utf8")).toBe("RIFF");
  });

  it("reads back meta and the stream, lists newest first, keeps accounts apart", async () => {
    await store.put(meta({ id: "a_old", createdAt: "2026-10-19T00:00:00.000Z" }), Buffer.from("old"));
    await store.put(meta({ id: "a_new", createdAt: "2026-10-20T00:00:00.000Z" }), Buffer.from("new"));
    await store.put(meta({ id: "a_x", authId: OTHER }), Buffer.from("x"));
    expect((await store.list(AUTH)).map((m) => m.id)).toEqual(["a_new", "a_old"]);
    expect((await store.list(OTHER)).map((m) => m.id)).toEqual(["a_x"]);
    expect(await store.getMeta(OTHER, "a_new")).toBeUndefined();
    expect(await store.open(OTHER, "a_new")).toBeUndefined();
    expect((await readAll((await store.open(AUTH, "a_new"))!)).toString()).toBe("new");
    expect(await store.list("MA_NOBODY")).toEqual([]);
  });

  it("delete removes both files; unknown or malformed ids are misses", async () => {
    await store.put(meta(), Buffer.from("RIFF"));
    expect(await store.delete(AUTH, "a_one")).toBe(true);
    expect(await readdir(join(dir, "accounts", HASH))).toEqual([]);
    expect(await store.delete(AUTH, "a_one")).toBe(false);
    expect(await store.getMeta(AUTH, "../../etc/passwd")).toBeUndefined();
    expect(await store.open(AUTH, "a/../b")).toBeUndefined();
  });
});

class FakeBucket implements GcsBucketLike {
  objects = new Map<string, { data: Buffer; o?: Record<string, unknown> }>();
  file(name: string): GcsFileLike {
    const self = this;
    return {
      name,
      async save(data, o) {
        self.objects.set(name, { data: Buffer.from(data), o: o as Record<string, unknown> });
      },
      async download() {
        const x = self.objects.get(name);
        if (!x) throw Object.assign(new Error("No such object"), { code: 404 });
        return [x.data];
      },
      async exists() {
        return [self.objects.has(name)];
      },
      async delete() {
        self.objects.delete(name);
      },
      createReadStream() {
        return Readable.from([self.objects.get(name)!.data]);
      },
    };
  }
  async getFiles(o: { prefix: string; matchGlob?: string }): Promise<[GcsFileLike[]]> {
    return [[...this.objects.keys()].filter((k) => k.startsWith(o.prefix) && k.endsWith(".json")).map((k) => this.file(k))];
  }
}

describe("GcsMediaStore (fake bucket)", () => {
  it("writes the WAV with content type plus a JSON sidecar, lists from sidecars, deletes both", async () => {
    const bucket = new FakeBucket();
    const store = new GcsMediaStore({ bucket: "b", prefix: "media", client: bucket });
    await store.put({ ...meta(), authToken: "secret-token" } as AudioMeta, Buffer.from("RIFF"));
    await store.put(meta({ id: "a_two", createdAt: "2026-10-21T00:00:00.000Z" }), Buffer.from("two"));
    const wavName = `media/accounts/${HASH}/a_one.wav`;
    expect([...bucket.objects.keys()].sort()).toEqual([`media/accounts/${HASH}/a_one.json`, wavName, `media/accounts/${HASH}/a_two.json`, `media/accounts/${HASH}/a_two.wav`]);
    expect(bucket.objects.get(wavName)!.o!.contentType).toBe("audio/wav");
    for (const { data, o } of bucket.objects.values()) {
      expect(data.toString()).not.toContain("secret-token");
      expect(JSON.stringify(o)).not.toContain(AUTH);
    }
    expect((await store.list(AUTH)).map((m) => m.id)).toEqual(["a_two", "a_one"]);
    expect(await store.getMeta(AUTH, "a_one")).toEqual(meta());
    expect(await store.list(OTHER)).toEqual([]);
    expect((await readAll((await store.open(AUTH, "a_one"))!)).toString()).toBe("RIFF");
    expect(await store.delete(AUTH, "a_one")).toBe(true);
    expect(bucket.objects.has(wavName)).toBe(false);
    expect(bucket.objects.has(`media/accounts/${HASH}/a_one.json`)).toBe(false);
    expect(await store.delete(AUTH, "a_one")).toBe(false);
    expect(await store.open(AUTH, "a_one")).toBeUndefined();
  });

  it("rejects a sidecar whose authId does not match the account", async () => {
    const bucket = new FakeBucket();
    const store = new GcsMediaStore({ bucket: "b", client: bucket });
    await bucket.file(store.objectName(AUTH, "a_one", "json")).save(JSON.stringify(meta({ authId: OTHER })));
    expect(await store.getMeta(AUTH, "a_one")).toBeUndefined();
    expect(await store.list(AUTH)).toEqual([]);
  });
});

// ── ffmpeg processing ──────────────────────────────────────────

const FFMPEG = process.env.VOBIZ_FFMPEG || "ffmpeg";
const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
    execFileSync(process.env.VOBIZ_FFPROBE || "ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Parses the fmt chunk of a WAV. */
function wavFormat(wav: Buffer) {
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") {
      return { format: wav.readUInt16LE(off + 8), channels: wav.readUInt16LE(off + 10), sampleRate: wav.readUInt32LE(off + 12), bits: wav.readUInt16LE(off + 22) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no fmt chunk");
}

const audioTmpDirs = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("vobiz-audio-")).length;

describe.skipIf(!hasFfmpeg)("FfmpegProcessor (real ffmpeg)", () => {
  let work: string;
  let mp3: Buffer;
  let webm: Buffer;
  let long: Buffer;
  let quietStart: Buffer;
  const proc = new FfmpegProcessor();
  const gen = (args: string[], out: string) => {
    execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", ...args, join(work, out)]);
    return readFile(join(work, out));
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "vobiz-media-gen-"));
    mp3 = await gen(["-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-b:a", "64k"], "in.mp3");
    webm = await gen(["-i", "sine=frequency=440:duration=2", "-c:a", "libopus"], "in.webm");
    quietStart = await gen(["-i", "aevalsrc=if(lt(t\\,1)\\,0\\,0.5*sin(440*2*PI*t)):s=44100:d=2", "-c:a", "libmp3lame"], "quiet.mp3");
    long = await gen(["-i", "sine=frequency=440:duration=4", "-c:a", "libmp3lame", "-b:a", "32k"], "long.mp3");
  });
  afterAll(() => rm(work, { recursive: true, force: true }));

  it("is available and caches the answer", async () => {
    expect(await proc.available()).toBe(true);
    expect(proc.available()).toBe(proc.available());
  });

  it.each([["mp3"], ["webm/opus"]])("converts %s to 8 kHz mono 16-bit PCM WAV of about 2 s, and cleans its temp files", async (kind) => {
    const before = await audioTmpDirs();
    const out = await proc.process(kind === "mp3" ? mp3 : webm, DEFAULT_AUDIO_LIMITS);
    expect(wavFormat(out.wav)).toEqual({ format: 1, channels: 1, sampleRate: 8000, bits: 16 });
    expect(out.durationSec).toBeGreaterThan(1.7);
    expect(out.durationSec).toBeLessThan(2.3);
    expect(out.durationSec).toBe(Math.round(wavDurationSec(out.wav) * 10) / 10);
    expect(await audioTmpDirs()).toBe(before);
  }, 30_000);

  it("trims leading silence", async () => {
    const out = await proc.process(quietStart, DEFAULT_AUDIO_LIMITS);
    expect(out.durationSec).toBeGreaterThan(0.8);
    expect(out.durationSec).toBeLessThan(1.5);
  }, 30_000);

  it("rejects a buffer that is not audio (415) and cleans up", async () => {
    const before = await audioTmpDirs();
    const r = await kindOf(proc.process(Buffer.from("this is definitely not an audio file ".repeat(50)), DEFAULT_AUDIO_LIMITS));
    expect(r).toMatchObject({ kind: "invalid_input", status: 415 });
    expect(await audioTmpDirs()).toBe(before);
  });

  it("rejects input over the duration limit and over the byte limit", async () => {
    expect(await kindOf(proc.process(long, { ...DEFAULT_AUDIO_LIMITS, maxDurationSec: 3 }))).toMatchObject({ kind: "invalid_input", status: 413 });
    expect(await kindOf(proc.process(mp3, { ...DEFAULT_AUDIO_LIMITS, maxInputBytes: 100 }))).toMatchObject({ kind: "invalid_input", status: 413 });
    expect(await kindOf(proc.process(Buffer.alloc(0), DEFAULT_AUDIO_LIMITS))).toMatchObject({ kind: "invalid_input", status: 400 });
  }, 30_000);
});

describe("FfmpegProcessor without ffmpeg", () => {
  it("reports unavailable and refuses to process with not_allowed", async () => {
    const proc = new FfmpegProcessor({ ffmpeg: "/nonexistent/ffmpeg", ffprobe: "/nonexistent/ffprobe" });
    expect(await proc.available()).toBe(false);
    expect(await kindOf(proc.process(Buffer.from("x"), DEFAULT_AUDIO_LIMITS))).toMatchObject({ kind: "not_allowed" });
  });
});

// ── Service ────────────────────────────────────────────────────

class FakeProcessor implements AudioProcessor {
  calls = 0;
  async available() {
    return true;
  }
  async process(input: Buffer, limits: AudioLimits) {
    this.calls++;
    if (input.length > limits.maxInputBytes) throw new VobizError("invalid_input", "too large", 413);
    if (input.toString() === "not audio") throw new VobizError("invalid_input", "no audio", 415);
    return { wav: Buffer.concat([Buffer.from("RIFF"), input]), durationSec: 1.5 };
  }
}

describe("createMediaService", () => {
  let dir: string;
  let clock: Date;
  let processor: FakeProcessor;
  const make = (o: { limits?: Partial<AudioLimits>; fetchImpl?: typeof fetch; importTimeoutMs?: number } = {}) =>
    createMediaService({ store: new LocalDiskMediaStore(dir), processor, log: silentLogger, now: () => clock, ...o });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vobiz-media-svc-"));
    clock = new Date(T0);
    processor = new FakeProcessor();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("validates names", () => {
    expect(normalizeAudioName("  Wake up (v2).mp3  ")).toBe("Wake up (v2).mp3");
    expect(normalizeAudioName("सुबह अलार्म")).toBe("सुबह अलार्म");
    for (const bad of ["", "   ", "x".repeat(81), "a/b", "<script>", "name;rm", 42]) {
      expect(() => normalizeAudioName(bad)).toThrow(VobizError);
    }
  });

  it("adds, lists, finds by id or name (case-insensitive), opens and deletes", async () => {
    const svc = make();
    const a = await svc.add(AUTH, Buffer.from("aaa"), { name: " Morning Alarm ", source: "upload", origin: "alarm.mp3" });
    expect(a).toMatchObject({ authId: AUTH, name: "Morning Alarm", durationSec: 1.5, bytes: 7, contentType: "audio/wav", source: "upload", origin: "alarm.mp3", createdAt: T0.toISOString() });
    expect(a.id).toMatch(/^a_[A-Za-z0-9_-]{16}$/);
    expect((await svc.find(AUTH, a.id))?.id).toBe(a.id);
    expect((await svc.find(AUTH, "morning alarm"))?.id).toBe(a.id);
    expect(await svc.find(OTHER, a.id)).toBeUndefined();
    expect(await svc.find(AUTH, "nope")).toBeUndefined();
    const opened = await svc.open(AUTH, a.id);
    expect(opened?.meta.id).toBe(a.id);
    expect((await readAll(opened!.stream)).toString()).toBe("RIFFaaa");
    expect(await svc.open(OTHER, a.id)).toBeUndefined();
    expect((await svc.list(AUTH)).map((m) => m.id)).toEqual([a.id]);
    expect((await svc.delete(AUTH, "MORNING ALARM"))?.id).toBe(a.id);
    expect(await svc.list(AUTH)).toEqual([]);
    expect(await svc.delete(AUTH, a.id)).toBeUndefined();
  });

  it("rejects a duplicate name (case-insensitive) before processing", async () => {
    const svc = make();
    await svc.add(AUTH, Buffer.from("a"), { name: "Alarm", source: "upload" });
    const r = await kindOf(svc.add(AUTH, Buffer.from("b"), { name: "ALARM", source: "upload" }));
    expect(r).toMatchObject({ kind: "invalid_input" });
    expect(r.message).toContain('An audio named "ALARM" already exists');
    expect(processor.calls).toBe(1);
    // Other accounts have their own namespace.
    await expect(svc.add(OTHER, Buffer.from("b"), { name: "Alarm", source: "upload" })).resolves.toBeTruthy();
  });

  it("enforces the per-account cap and the per-UTC-day cap", async () => {
    const svc = make({ limits: { maxPerAccount: 3, maxUploadsPerDay: 2 } });
    await svc.add(AUTH, Buffer.from("1"), { name: "one", source: "upload" });
    await svc.add(AUTH, Buffer.from("2"), { name: "two", source: "upload" });
    expect(await kindOf(svc.add(AUTH, Buffer.from("3"), { name: "three", source: "upload" }))).toMatchObject({ kind: "not_allowed", status: 403 });
    clock = new Date("2026-10-21T00:00:01.000Z");
    await svc.add(AUTH, Buffer.from("3"), { name: "three", source: "upload" });
    const full = await kindOf(svc.add(AUTH, Buffer.from("4"), { name: "four", source: "upload" }));
    expect(full).toMatchObject({ kind: "not_allowed" });
    expect(full.message).toContain("library is full");
    expect(processor.calls).toBe(3);
  });

  it("passes processor errors through", async () => {
    expect(await kindOf(make().add(AUTH, Buffer.from("not audio"), { name: "x", source: "upload" }))).toMatchObject({ kind: "invalid_input", status: 415 });
  });

  describe("importFromUrl", () => {
    type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
    const fakeFetch = (h: Handler) => {
      const seen: string[] = [];
      const impl = (async (input: string | URL, init: RequestInit = {}) => {
        seen.push(String(input));
        return h(String(input), init);
      }) as typeof fetch;
      return { impl, seen };
    };

    it("downloads an https file and stores it with origin = URL without query", async () => {
      const f = fakeFetch(() => new Response(Buffer.from("mp3data"), { status: 200 }));
      const m = await make({ fetchImpl: f.impl }).importFromUrl(AUTH, "https://cdn.example.com/a/alarm.mp3?sig=SECRET#x", "Alarm");
      expect(m).toMatchObject({ name: "Alarm", source: "url", origin: "https://cdn.example.com/a/alarm.mp3", bytes: 11 });
      expect(JSON.stringify(m)).not.toContain("SECRET");
    });

    it("refuses http, credentials and private hosts without fetching", async () => {
      const f = fakeFetch(() => new Response("x"));
      const svc = make({ fetchImpl: f.impl });
      expect(await kindOf(svc.importFromUrl(AUTH, "http://cdn.example.com/a.mp3", "a"))).toMatchObject({ kind: "invalid_input" });
      expect(await kindOf(svc.importFromUrl(AUTH, "https://u:p@cdn.example.com/a.mp3", "a"))).toMatchObject({ kind: "invalid_input" });
      expect(await kindOf(svc.importFromUrl(AUTH, "not a url", "a"))).toMatchObject({ kind: "invalid_input" });
      for (const h of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]", "metadata.google.internal"]) {
        expect(await kindOf(svc.importFromUrl(AUTH, `https://${h}/a.mp3`, "a"))).toMatchObject({ kind: "not_allowed" });
      }
      expect(await kindOf(svc.importFromUrl(AUTH, "https://cdn.example.com/a.mp3", "bad/name"))).toMatchObject({ kind: "invalid_input" });
      expect(f.seen).toEqual([]);
    });

    it("follows up to 3 redirects, re-checking each hop", async () => {
      const chain = (n: number, finalHost = "cdn.example.com") =>
        fakeFetch((url) => {
          const hop = Number(new URL(url).searchParams.get("h") ?? 0);
          if (hop < n) return new Response(null, { status: 302, headers: { location: hop + 1 === n ? `https://${finalHost}/f.mp3?h=${n}` : `/r?h=${hop + 1}` } });
          return new Response(Buffer.from("ok"));
        });
      const ok = chain(3);
      await expect(make({ fetchImpl: ok.impl }).importFromUrl(AUTH, "https://cdn.example.com/r", "three")).resolves.toMatchObject({ origin: "https://cdn.example.com/r" });
      expect(ok.seen).toHaveLength(4);
      const tooMany = chain(4);
      expect(await kindOf(make({ fetchImpl: tooMany.impl }).importFromUrl(AUTH, "https://cdn.example.com/r", "four"))).toMatchObject({ kind: "invalid_input" });
      expect(tooMany.seen).toHaveLength(4);
      const toPrivate = chain(1, "127.0.0.1");
      expect(await kindOf(make({ fetchImpl: toPrivate.impl }).importFromUrl(AUTH, "https://cdn.example.com/r", "p"))).toMatchObject({ kind: "not_allowed" });
      expect(toPrivate.seen).toHaveLength(1);
      const toHttp = fakeFetch(() => new Response(null, { status: 301, headers: { location: "http://cdn.example.com/x" } }));
      expect(await kindOf(make({ fetchImpl: toHttp.impl }).importFromUrl(AUTH, "https://cdn.example.com/r", "h"))).toMatchObject({ kind: "invalid_input" });
    });

    it("aborts a streamed body beyond maxInputBytes and refuses an oversized Content-Length", async () => {
      let pulled = 0;
      const endless = fakeFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                pulled++;
                c.enqueue(new Uint8Array(1024));
              },
            }),
          ),
      );
      expect(await kindOf(make({ fetchImpl: endless.impl, limits: { maxInputBytes: 10_000 } }).importFromUrl(AUTH, "https://cdn.example.com/a", "a"))).toMatchObject({ kind: "invalid_input", status: 413 });
      expect(pulled).toBeLessThan(20);
      const declared = fakeFetch(() => new Response("x", { headers: { "content-length": "999999999" } }));
      expect(await kindOf(make({ fetchImpl: declared.impl }).importFromUrl(AUTH, "https://cdn.example.com/a", "a"))).toMatchObject({ status: 413 });
      expect(processor.calls).toBe(0);
    });

    it("maps HTTP errors and times out a slow server", async () => {
      const notFound = fakeFetch(() => new Response("nope", { status: 404 }));
      const r = await kindOf(make({ fetchImpl: notFound.impl }).importFromUrl(AUTH, "https://cdn.example.com/a", "a"));
      expect(r).toMatchObject({ kind: "invalid_input", status: 502 });
      expect(r.message).toContain("HTTP 404");
      const hang = fakeFetch(
        (_u, init) =>
          new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
      );
      expect(await kindOf(make({ fetchImpl: hang.impl, importTimeoutMs: 30 }).importFromUrl(AUTH, "https://cdn.example.com/a", "a"))).toMatchObject({ kind: "invalid_input", status: 504 });
    });

    it("checks name and caps before downloading", async () => {
      const f = fakeFetch(() => new Response("x"));
      const svc = make({ fetchImpl: f.impl, limits: { maxPerAccount: 1 } });
      await svc.add(AUTH, Buffer.from("a"), { name: "Alarm", source: "upload" });
      expect(await kindOf(svc.importFromUrl(AUTH, "https://cdn.example.com/a", "alarm"))).toMatchObject({ kind: "invalid_input" });
      expect(await kindOf(svc.importFromUrl(AUTH, "https://cdn.example.com/a", "other"))).toMatchObject({ kind: "not_allowed" });
      expect(f.seen).toEqual([]);
    });
  });

  it.skipIf(!hasFfmpeg)("end to end: real ffmpeg + local disk", async () => {
    const work = await mkdtemp(join(tmpdir(), "vobiz-media-gen-"));
    try {
      execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", join(work, "a.mp3")]);
      const svc = createMediaService({ store: new LocalDiskMediaStore(dir), processor: new FfmpegProcessor(), log: silentLogger });
      const m = await svc.add(AUTH, await readFile(join(work, "a.mp3")), { name: "Beep", source: "upload" });
      const opened = await svc.open(AUTH, m.id);
      const wav = await readAll(opened!.stream);
      expect(wav.length).toBe(m.bytes);
      expect(wavFormat(wav)).toMatchObject({ channels: 1, sampleRate: 8000, bits: 16 });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── Backend selection ──────────────────────────────────────────

describe("createMediaBackend", () => {
  it("defaults to local disk with the default limits", () => {
    const b = createMediaBackend({}, silentLogger);
    expect(b.mode).toBe("local");
    expect(b.store).toBeInstanceOf(LocalDiskMediaStore);
    expect((b.store as LocalDiskMediaStore).dir).toBe(join(tmpdir(), "vobiz-mcp-media"));
    expect(b.processor).toBeInstanceOf(FfmpegProcessor);
    expect(b.limits).toEqual({ maxInputBytes: 15 * 1024 * 1024, maxDurationSec: 300, maxPerAccount: 50, maxUploadsPerDay: 20 });
  });

  it("uses GCS when VOBIZ_MEDIA_BUCKET is set and reads every limit and binary", () => {
    const b = createMediaBackend(
      {
        VOBIZ_MEDIA_BUCKET: "my-bucket",
        VOBIZ_MEDIA_MAX_INPUT_MB: "5",
        VOBIZ_MEDIA_MAX_DURATION_SEC: "60",
        VOBIZ_MEDIA_MAX_PER_ACCOUNT: "10",
        VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY: "3",
        VOBIZ_FFMPEG: "/opt/ff/ffmpeg",
        VOBIZ_FFPROBE: "/opt/ff/ffprobe",
      },
      silentLogger,
    );
    expect(b.mode).toBe("gcs");
    expect(b.store).toBeInstanceOf(GcsMediaStore);
    expect(b.limits).toEqual({ maxInputBytes: 5 * 1024 * 1024, maxDurationSec: 60, maxPerAccount: 10, maxUploadsPerDay: 3 });
    expect((b.processor as FfmpegProcessor).ffmpeg).toBe("/opt/ff/ffmpeg");
    expect((b.processor as FfmpegProcessor).ffprobe).toBe("/opt/ff/ffprobe");
  });

  it("honours VOBIZ_MEDIA_DIR and rejects bad limits", () => {
    expect((createMediaBackend({ VOBIZ_MEDIA_DIR: "/srv/media" }, silentLogger).store as LocalDiskMediaStore).dir).toBe("/srv/media");
    expect(() => createMediaBackend({ VOBIZ_MEDIA_MAX_INPUT_MB: "abc" }, silentLogger)).toThrow(/VOBIZ_MEDIA_MAX_INPUT_MB/);
    expect(() => createMediaBackend({ VOBIZ_MEDIA_MAX_PER_ACCOUNT: "0" }, silentLogger)).toThrow(/VOBIZ_MEDIA_MAX_PER_ACCOUNT/);
  });
});
