/**
 * Audio library backend selection and the module's public surface.
 *
 * VOBIZ_MEDIA_BUCKET set → Google Cloud Storage (durable, multi-replica; the bucket stays private).
 * Otherwise → local disk under VOBIZ_MEDIA_DIR (default `${os.tmpdir()}/vobiz-mcp-media`; single host only).
 * @google-cloud/storage is imported lazily, on first use, so the npm/stdio server never loads it.
 */
import type { Logger } from "../logger.js";
import { FfmpegProcessor } from "./processing.js";
import { DEFAULT_AUDIO_LIMITS } from "./service.js";
import { DEFAULT_MEDIA_DIR, GcsMediaStore, LocalDiskMediaStore } from "./store.js";
import type { AudioLimits, AudioProcessor, MediaStore } from "./types.js";

export * from "./types.js";
export {
  LocalDiskMediaStore,
  GcsMediaStore,
  DEFAULT_MEDIA_DIR,
  accountDir,
  cleanMeta,
  isValidAudioId,
  type GcsBucketLike,
  type GcsFileLike,
  type GcsMediaStoreOptions,
} from "./store.js";
export { FfmpegProcessor, FFMPEG_TIMEOUT_MS, wavDurationSec, type FfmpegProcessorOptions } from "./processing.js";
export {
  createMediaService,
  normalizeAudioName,
  DEFAULT_AUDIO_LIMITS,
  IMPORT_MAX_REDIRECTS,
  IMPORT_TIMEOUT_MS,
  type MediaServiceOptions,
} from "./service.js";

export interface MediaBackend {
  mode: "gcs" | "local";
  store: MediaStore;
  processor: AudioProcessor;
  /** From the VOBIZ_MEDIA_* limits, else DEFAULT_AUDIO_LIMITS. */
  limits: AudioLimits;
}

function intEnv(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** Picks the store from the environment and starts a background ffmpeg availability check (logged, never fatal). */
export function createMediaBackend(env: NodeJS.ProcessEnv, log: Logger): MediaBackend {
  const v = (k: string) => env[k]?.trim() || undefined;
  const limits: AudioLimits = {
    maxInputBytes:
      intEnv("VOBIZ_MEDIA_MAX_INPUT_MB", env.VOBIZ_MEDIA_MAX_INPUT_MB, DEFAULT_AUDIO_LIMITS.maxInputBytes / (1024 * 1024), 1, 100) * 1024 * 1024,
    maxDurationSec: intEnv("VOBIZ_MEDIA_MAX_DURATION_SEC", env.VOBIZ_MEDIA_MAX_DURATION_SEC, DEFAULT_AUDIO_LIMITS.maxDurationSec, 1, 3600),
    maxPerAccount: intEnv("VOBIZ_MEDIA_MAX_PER_ACCOUNT", env.VOBIZ_MEDIA_MAX_PER_ACCOUNT, DEFAULT_AUDIO_LIMITS.maxPerAccount, 1, 1000),
    maxUploadsPerDay: intEnv("VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY", env.VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY, DEFAULT_AUDIO_LIMITS.maxUploadsPerDay, 1, 1000),
  };
  const processor = new FfmpegProcessor({ ffmpeg: v("VOBIZ_FFMPEG"), ffprobe: v("VOBIZ_FFPROBE") });
  void processor.available().then((ok) => {
    if (!ok) log.info("media: WARNING ffmpeg/ffprobe not found; audio uploads and imports are disabled. Install ffmpeg or set VOBIZ_FFMPEG and VOBIZ_FFPROBE.");
  });
  const bucket = v("VOBIZ_MEDIA_BUCKET");
  if (bucket) {
    log.info(`media: Cloud Storage bucket ${bucket}`);
    return { mode: "gcs", limits, processor, store: new GcsMediaStore({ bucket }) };
  }
  const dir = v("VOBIZ_MEDIA_DIR") ?? DEFAULT_MEDIA_DIR;
  log.info("media: WARNING local-disk audio library (single host only). Set VOBIZ_MEDIA_BUCKET for durable storage.");
  return { mode: "local", limits, processor, store: new LocalDiskMediaStore(dir) };
}
