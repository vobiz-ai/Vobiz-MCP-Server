/**
 * Audio validation and conversion with ffmpeg/ffprobe (child processes; nothing is linked in).
 *
 * Every input is written to a private temp folder, probed (an audio stream must exist and the duration must
 * be within the limit), loudness-normalised, trimmed of leading silence and converted to 8 kHz mono 16-bit
 * PCM WAV, the format Vobiz plays without transcoding. The declared content type is never trusted.
 * Temp files are always removed.
 *
 * Hardening: the container is sniffed from magic bytes and passed as an explicit `-f` (no format guessing, so
 * playlist/concat demuxers can never be picked), `-protocol_whitelist file,pipe` blocks network protocols, the
 * child gets only PATH in its environment (no secrets), runs single-threaded under a 25 s timeout, and at most
 * VOBIZ_AUDIO_MAX_CONCURRENT (default 2) conversions run at once in this process.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VobizError } from "../errors.js";
import type { AudioLimits, AudioProcessor, ProcessedAudio } from "./types.js";

export const FFMPEG_TIMEOUT_MS = 25_000;
/** Conversions allowed at once in this process (VOBIZ_AUDIO_MAX_CONCURRENT). */
export const DEFAULT_MAX_CONCURRENT = 2;
/** Longest wait for a conversion slot before answering rate_limited. */
export const QUEUE_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 15_000;
const SAMPLE_RATE = 8000;
const FILTER = "loudnorm=I=-18:TP=-1.5:LRA=11,silenceremove=start_periods=1:start_silence=0.3:start_threshold=-45dB";

export interface FfmpegProcessorOptions {
  /** ffmpeg binary. Default VOBIZ_FFMPEG or "ffmpeg" on PATH. */
  ffmpeg?: string;
  /** ffprobe binary. Default VOBIZ_FFPROBE or "ffprobe" on PATH. */
  ffprobe?: string;
  /** Conversion timeout, default 25 s. */
  timeoutMs?: number;
  /** Conversion slots; default the process-wide semaphore sized by VOBIZ_AUDIO_MAX_CONCURRENT. */
  semaphore?: Semaphore;
}

/** Counting semaphore with a bounded wait. acquire() resolves to a release function, or rejects rate_limited. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly max: number,
    readonly waitMs: number = QUEUE_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error("Semaphore size must be a positive integer");
  }

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new VobizError("rate_limited", "Too many conversions in progress. Try again in a moment.", 429));
      }, this.waitMs);
      this.waiters.push(go);
    });
    return this.releaser(); // the slot was handed over by release(); `active` is unchanged
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** VOBIZ_AUDIO_MAX_CONCURRENT: an integer 1..16, default 2. */
export function maxConcurrentFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOBIZ_AUDIO_MAX_CONCURRENT?.trim();
  const n = raw ? Number(raw) : DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("VOBIZ_AUDIO_MAX_CONCURRENT must be an integer between 1 and 16");
  return n;
}

let shared: Semaphore | undefined;
/** The process-wide conversion semaphore (per instance on Cloud Run), sized once from VOBIZ_AUDIO_MAX_CONCURRENT. */
export function sharedSemaphore(): Semaphore {
  shared ??= new Semaphore(maxConcurrentFromEnv());
  return shared;
}

/** ffmpeg demuxer for the container in `head`, from magic bytes only; undefined when not a supported audio format. */
export function sniffDemuxer(head: Buffer): "mp3" | "wav" | "mov" | "ogg" | "matroska" | "aac" | "flac" | undefined {
  const at = (off: number, ascii: string) => head.length >= off + ascii.length && head.toString("latin1", off, off + ascii.length) === ascii;
  if (at(0, "ID3")) return "mp3";
  if (at(0, "RIFF") && at(8, "WAVE")) return "wav";
  if (at(4, "ftyp")) return "mov"; // mp4 / m4a / MediaRecorder audio/mp4
  if (at(0, "OggS")) return "ogg";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "matroska"; // EBML: webm / mkv
  if (at(0, "fLaC")) return "flac";
  if (head.length >= 2 && head[0] === 0xff) {
    if ((head[1] & 0xf6) === 0xf0) return "aac"; // ADTS: sync 0xFFF, layer 00
    if ((head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0 && (head[1] & 0x18) !== 0x08) return "mp3"; // MPEG audio frame sync, valid layer and version
  }
  return undefined;
}

const unsupported = () => new VobizError("invalid_input", "Unsupported audio format. Use MP3, WAV, M4A, OGG, WebM, AAC or FLAC.", 415);

/** Only PATH reaches ffmpeg/ffprobe: VOBIZ_HOSTED_SECRET, tokens and cloud credentials are never inherited. */
const childEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: childEnv() }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const timedOut = (e: unknown) => !!e && typeof e === "object" && ((e as { killed?: boolean }).killed === true || (e as { signal?: string }).signal === "SIGKILL");

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Duration of a PCM WAV from its `data` chunk (falls back to the header-less size). */
export function wavDurationSec(wav: Buffer, sampleRate = SAMPLE_RATE, bytesPerSample = 2): number {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return Math.min(size, wav.length - off - 8) / (sampleRate * bytesPerSample);
    off += 8 + size + (size % 2);
  }
  return Math.max(0, wav.length - 44) / (sampleRate * bytesPerSample);
}

const noAudio = (msg = "The file has no audio the server could read. Use an MP3, WAV, M4A, OGG/Opus, WebM, AAC or FLAC file.") =>
  new VobizError("invalid_input", msg, 415);

export class FfmpegProcessor implements AudioProcessor {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  private readonly timeoutMs: number;
  private readonly semaphore?: Semaphore;
  private availablePromise?: Promise<boolean>;

  constructor(o: FfmpegProcessorOptions = {}) {
    this.ffmpeg = o.ffmpeg || process.env.VOBIZ_FFMPEG?.trim() || "ffmpeg";
    this.ffprobe = o.ffprobe || process.env.VOBIZ_FFPROBE?.trim() || "ffprobe";
    this.timeoutMs = o.timeoutMs ?? FFMPEG_TIMEOUT_MS;
    this.semaphore = o.semaphore;
  }

  /** Runs `ffmpeg -version` and `ffprobe -version` once; the answer is cached for the process lifetime. */
  available(): Promise<boolean> {
    this.availablePromise ??= Promise.all([run(this.ffmpeg, ["-version"], 10_000), run(this.ffprobe, ["-version"], 10_000)]).then(
      () => true,
      () => false,
    );
    return this.availablePromise;
  }

  async process(input: Buffer, limits: AudioLimits): Promise<ProcessedAudio> {
    if (!input?.length) throw new VobizError("invalid_input", "The audio file is empty.", 400);
    if (input.length > limits.maxInputBytes) {
      throw new VobizError("invalid_input", `The audio file is larger than ${Math.floor(limits.maxInputBytes / (1024 * 1024))} MB.`, 413);
    }
    if (!(await this.available())) {
      throw new VobizError("not_allowed", "Audio processing (ffmpeg) is not available on this server, so audio files cannot be added.");
    }
    const demuxer = sniffDemuxer(input.subarray(0, 16));
    if (!demuxer) throw unsupported();
    const release = await (this.semaphore ?? sharedSemaphore()).acquire();
    try {
      return await this.convert(input, demuxer, limits);
    } finally {
      release();
    }
  }

  private async convert(input: Buffer, demuxer: string, limits: AudioLimits): Promise<ProcessedAudio> {
    const dir = await mkdtemp(join(tmpdir(), "vobiz-audio-"));
    try {
      const inPath = join(dir, "in");
      const outPath = join(dir, "out.wav");
      await writeFile(inPath, input, { mode: 0o600 });

      // Refuse over-long input from the probe, before spending a decode on it.
      const probed = await this.probe(inPath, demuxer);
      if (probed.durationSec !== undefined && probed.durationSec > limits.maxDurationSec) throw tooLong(limits);

      try {
        await run(
          this.ffmpeg,
          [
            "-nostdin", "-hide_banner", "-v", "error", "-y",
            "-threads", "1", "-filter_threads", "1",
            "-protocol_whitelist", "file,pipe", "-f", demuxer,
            "-i", inPath,
            // Hard stop just past the limit, for inputs whose container does not declare a duration (e.g. MediaRecorder WebM).
            "-t", String(limits.maxDurationSec + 1),
            "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le",
            "-af", FILTER,
            outPath,
          ],
          this.timeoutMs,
        );
      } catch (e) {
        if (timedOut(e)) throw new VobizError("invalid_input", "The audio took too long to convert. Try a shorter or simpler file.", 415);
        throw noAudio("The audio could not be decoded. Use an MP3, WAV, M4A, OGG/Opus, WebM, AAC or FLAC file.");
      }

      const wav = await readFile(outPath);
      const durationSec = round1(wavDurationSec(wav));
      if (durationSec > limits.maxDurationSec) throw tooLong(limits);
      if (durationSec < 0.1) throw noAudio("The audio is silent or too short to play.");
      return { wav, durationSec };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async probe(path: string, demuxer: string): Promise<{ durationSec?: number }> {
    let out: RunResult;
    try {
      out = await run(
        this.ffprobe,
        ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer, "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", path],
        PROBE_TIMEOUT_MS,
      );
    } catch {
      throw noAudio();
    }
    let j: { streams?: { codec_type?: string; duration?: string }[]; format?: { duration?: string } };
    try {
      j = JSON.parse(out.stdout);
    } catch {
      throw noAudio();
    }
    if (!j.streams?.some((s) => s.codec_type === "audio")) throw noAudio();
    // The longest duration any part of the file declares (format or audio stream).
    const ds = [j.format?.duration, ...j.streams.filter((x) => x.codec_type === "audio").map((x) => x.duration)].map(Number).filter((d) => Number.isFinite(d) && d > 0);
    return { durationSec: ds.length ? Math.max(...ds) : undefined };
  }
}

function tooLong(limits: AudioLimits): VobizError {
  const m = limits.maxDurationSec;
  const human = m % 60 === 0 ? `${m / 60} minute${m === 60 ? "" : "s"}` : `${m} seconds`;
  return new VobizError("invalid_input", `The audio is longer than ${human}. Trim it and try again.`, 413);
}
