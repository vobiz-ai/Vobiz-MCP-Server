import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VobizError } from "../src/errors.js";
import { DEFAULT_AUDIO_LIMITS, FfmpegProcessor, Semaphore, maxConcurrentFromEnv, sniffDemuxer } from "../src/media/index.js";

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof VobizError ? { kind: e.kind, status: e.status, message: e.message } : { kind: "other", message: String(e) };
  }
  return { kind: "resolved" };
};

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

const WAV_HEAD = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);

describe("sniffDemuxer", () => {
  it.each<[string, Buffer, string | undefined]>([
    ["ID3 tag", Buffer.from("ID3\x04\x00\x00\x00\x00", "latin1"), "mp3"],
    ["MPEG-1 layer III frame", Buffer.from([0xff, 0xfb, 0x90, 0x64]), "mp3"],
    ["MPEG-2 layer III frame", Buffer.from([0xff, 0xf3, 0x90, 0x64]), "mp3"],
    ["ADTS AAC", Buffer.from([0xff, 0xf1, 0x50, 0x80]), "aac"],
    ["RIFF/WAVE", WAV_HEAD, "wav"],
    ["RIFF but AVI", Buffer.from("RIFF\0\0\0\0AVI LIST", "latin1"), undefined],
    ["ftyp M4A", Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0", "latin1"), "mov"],
    ["OggS", Buffer.from("OggS\0\x02", "latin1"), "ogg"],
    ["EBML (webm)", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), "matroska"],
    ["fLaC", Buffer.from("fLaC\0\0\0\x22", "latin1"), "flac"],
    ["HLS playlist", Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n"), undefined],
    ["ffconcat", Buffer.from("ffconcat version 1.0\nfile /etc/passwd\n"), undefined],
    ["text", Buffer.from("hello world, not audio"), undefined],
    ["0xff alone", Buffer.from([0xff]), undefined],
    ["empty", Buffer.alloc(0), undefined],
  ])("%s → %s", (_label, head, want) => {
    expect(sniffDemuxer(head)).toBe(want);
  });
});

describe("Semaphore", () => {
  it("admits up to max at once, hands slots over in order, and ignores double release", async () => {
    const s = new Semaphore(2, 1000);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.inUse).toBe(2);
    let third = false;
    const p3 = s.acquire().then((r) => ((third = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    r1();
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(s.inUse).toBe(2);
    r2();
    r3();
    expect(s.inUse).toBe(0);
  });

  it("rejects with rate_limited (429) when no slot frees up in time", async () => {
    const s = new Semaphore(1, 20);
    const r = await s.acquire();
    expect(await kindOf(s.acquire())).toMatchObject({ kind: "rate_limited", status: 429, message: "Too many conversions in progress. Try again in a moment." });
    r();
    expect(s.inUse).toBe(0);
    (await s.acquire())();
  });

  it("reads VOBIZ_AUDIO_MAX_CONCURRENT (default 2, 1..16)", () => {
    expect(maxConcurrentFromEnv({})).toBe(2);
    expect(maxConcurrentFromEnv({ VOBIZ_AUDIO_MAX_CONCURRENT: " 4 " })).toBe(4);
    for (const bad of ["0", "17", "1.5", "two"]) expect(() => maxConcurrentFromEnv({ VOBIZ_AUDIO_MAX_CONCURRENT: bad })).toThrow();
  });
});

describe("FfmpegProcessor with stand-in binaries", () => {
  let dir: string;
  const SECRET = "hosted-secret-should-never-reach-ffmpeg";
  const saved = process.env.VOBIZ_HOSTED_SECRET;

  /**
   * Writes fake ffprobe/ffmpeg shell scripts. They answer -version, log argv and env, and ffprobe prints a probe
   * JSON with the given duration after `sleep` seconds; ffmpeg exits 1 (decode never succeeds).
   */
  async function fakes(o: { duration?: number; sleep?: number } = {}) {
    const log = join(dir, "calls.log");
    const envLog = join(dir, "env.log");
    const probeJson = JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: String(o.duration ?? 2) } });
    const script = (name: string, body: string) => `#!/bin/sh
[ "$1" = "-version" ] && exit 0
echo "${name} $*" >> "${log}"
env >> "${envLog}"
${body}
`;
    const ffprobe = join(dir, "ffprobe");
    const ffmpeg = join(dir, "ffmpeg");
    await writeFile(ffprobe, script("ffprobe", `sleep ${o.sleep ?? 0}\necho '${probeJson}'`));
    await writeFile(ffmpeg, script("ffmpeg", "exit 1"));
    await chmod(ffprobe, 0o755);
    await chmod(ffmpeg, 0o755);
    const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    const env = () => readFile(envLog, "utf8").catch(() => "");
    return { ffprobe, ffmpeg, calls, env };
  }

  beforeAll(async () => {
    process.env.VOBIZ_HOSTED_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.VOBIZ_HOSTED_SECRET;
    else process.env.VOBIZ_HOSTED_SECRET = saved;
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vobiz-media-fakes-"));
    return () => rm(dir, { recursive: true, force: true });
  });

  it("passes only PATH to the children, and an explicit demuxer plus a protocol whitelist", async () => {
    const f = await fakes();
    const proc = new FfmpegProcessor({ ffmpeg: f.ffmpeg, ffprobe: f.ffprobe, semaphore: new Semaphore(2) });
    expect(await kindOf(proc.process(Buffer.concat([WAV_HEAD, Buffer.alloc(64)]), DEFAULT_AUDIO_LIMITS))).toMatchObject({ kind: "invalid_input", status: 415 });
    const env = await f.env();
    expect(env).not.toContain(SECRET);
    expect(env).not.toContain("VOBIZ_");
    expect(env).toMatch(/^PATH=/m);
    const [probe, convert] = await f.calls();
    expect(probe).toContain("-protocol_whitelist file,pipe -f wav");
    expect(convert).toContain("-threads 1");
    expect(convert).toMatch(/-protocol_whitelist file,pipe -f wav -i \S+\/in /);
  });

  it("refuses an unrecognised container without starting ffprobe or ffmpeg", async () => {
    const f = await fakes();
    const proc = new FfmpegProcessor({ ffmpeg: f.ffmpeg, ffprobe: f.ffprobe, semaphore: new Semaphore(2) });
    for (const body of ["#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/latest\n", "ffconcat version 1.0\nfile /etc/passwd\n", "not audio at all"]) {
      expect(await kindOf(proc.process(Buffer.from(body), DEFAULT_AUDIO_LIMITS))).toMatchObject({
        kind: "invalid_input",
        status: 415,
        message: "Unsupported audio format. Use MP3, WAV, M4A, OGG, WebM, AAC or FLAC.",
      });
    }
    expect(await f.calls()).toEqual([]);
  });

  it("refuses an over-long file from the probe, before decoding", async () => {
    const f = await fakes({ duration: 999 });
    const proc = new FfmpegProcessor({ ffmpeg: f.ffmpeg, ffprobe: f.ffprobe, semaphore: new Semaphore(2) });
    expect(await kindOf(proc.process(Buffer.concat([WAV_HEAD, Buffer.alloc(64)]), DEFAULT_AUDIO_LIMITS))).toMatchObject({ kind: "invalid_input", status: 413 });
    const calls = await f.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^ffprobe /);
  });

  it("runs at most `max` conversions at once and answers rate_limited when the wait runs out", async () => {
    const f = await fakes({ sleep: 0.4 });
    const proc = new FfmpegProcessor({ ffmpeg: f.ffmpeg, ffprobe: f.ffprobe, semaphore: new Semaphore(1, 50) });
    const input = Buffer.concat([WAV_HEAD, Buffer.alloc(64)]);
    const results = await Promise.all([kindOf(proc.process(input, DEFAULT_AUDIO_LIMITS)), kindOf(proc.process(input, DEFAULT_AUDIO_LIMITS))]);
    expect(results.map((r) => r.kind).sort()).toEqual(["invalid_input", "rate_limited"]);
    expect(results.find((r) => r.kind === "rate_limited")).toMatchObject({ status: 429 });
    expect((await f.calls()).filter((c) => c.startsWith("ffprobe"))).toHaveLength(1);
  });
});

describe.skipIf(!hasFfmpeg)("FfmpegProcessor sniffs and converts every supported container (real ffmpeg)", () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "vobiz-media-gen-"));
  });
  afterAll(() => rm(work, { recursive: true, force: true }));

  it.each<[string, string[], string]>([
    ["in.mp3", ["-c:a", "libmp3lame", "-b:a", "32k"], "mp3"],
    ["in.wav", ["-c:a", "pcm_s16le"], "wav"],
    ["in.m4a", ["-c:a", "aac", "-b:a", "32k"], "mov"],
    ["in.ogg", ["-c:a", "libopus"], "ogg"],
    ["in.webm", ["-c:a", "libopus"], "matroska"],
    ["in.aac", ["-c:a", "aac", "-b:a", "32k", "-f", "adts"], "aac"],
    ["in.flac", ["-c:a", "flac"], "flac"],
  ])("%s", async (file, codec, demuxer) => {
    const out = join(work, file);
    try {
      execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...codec, out]);
    } catch {
      return; // this ffmpeg build lacks the encoder; nothing to check
    }
    const buf = await readFile(out);
    expect(sniffDemuxer(buf.subarray(0, 16))).toBe(demuxer);
    const res = await new FfmpegProcessor({ semaphore: new Semaphore(2) }).process(buf, DEFAULT_AUDIO_LIMITS);
    expect(res.durationSec).toBeGreaterThan(0.5);
    expect(res.durationSec).toBeLessThan(1.5);
  }, 30_000);
});
