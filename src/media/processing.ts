/**
 * Audio validation and conversion with ffmpeg/ffprobe (child processes; nothing is linked in).
 *
 * Every input is written to a private temp folder, probed (an audio stream must exist and the duration must
 * be within the limit), loudness-normalised, trimmed of leading silence and converted to 8 kHz mono 16-bit
 * PCM WAV, the format Vobiz plays without transcoding. The declared content type is never trusted.
 * Temp files are always removed.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VobizError } from "../errors.js";
import type { AudioLimits, AudioProcessor, ProcessedAudio } from "./types.js";

export const FFMPEG_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const SAMPLE_RATE = 8000;
const FILTER = "loudnorm=I=-18:TP=-1.5:LRA=11,silenceremove=start_periods=1:start_silence=0.3:start_threshold=-45dB";

export interface FfmpegProcessorOptions {
  /** ffmpeg binary. Default VOBIZ_FFMPEG or "ffmpeg" on PATH. */
  ffmpeg?: string;
  /** ffprobe binary. Default VOBIZ_FFPROBE or "ffprobe" on PATH. */
  ffprobe?: string;
  /** Conversion timeout, default 60 s. */
  timeoutMs?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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
  private availablePromise?: Promise<boolean>;

  constructor(o: FfmpegProcessorOptions = {}) {
    this.ffmpeg = o.ffmpeg || process.env.VOBIZ_FFMPEG?.trim() || "ffmpeg";
    this.ffprobe = o.ffprobe || process.env.VOBIZ_FFPROBE?.trim() || "ffprobe";
    this.timeoutMs = o.timeoutMs ?? FFMPEG_TIMEOUT_MS;
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
    const dir = await mkdtemp(join(tmpdir(), "vobiz-audio-"));
    try {
      const inPath = join(dir, "in");
      const outPath = join(dir, "out.wav");
      await writeFile(inPath, input, { mode: 0o600 });

      const probed = await this.probe(inPath);
      if (probed.durationSec !== undefined && probed.durationSec > limits.maxDurationSec) throw tooLong(limits);

      try {
        await run(
          this.ffmpeg,
          [
            "-nostdin", "-hide_banner", "-v", "error", "-y",
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

  private async probe(path: string): Promise<{ durationSec?: number }> {
    let out: RunResult;
    try {
      out = await run(this.ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path], PROBE_TIMEOUT_MS);
    } catch {
      throw noAudio();
    }
    let j: { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    try {
      j = JSON.parse(out.stdout);
    } catch {
      throw noAudio();
    }
    if (!j.streams?.some((s) => s.codec_type === "audio")) throw noAudio();
    const d = Number(j.format?.duration);
    return { durationSec: Number.isFinite(d) && d > 0 ? d : undefined };
  }
}

function tooLong(limits: AudioLimits): VobizError {
  const m = limits.maxDurationSec;
  const human = m % 60 === 0 ? `${m / 60} minute${m === 60 ? "" : "s"}` : `${m} seconds`;
  return new VobizError("invalid_input", `The audio is longer than ${human}. Trim it and try again.`, 413);
}
