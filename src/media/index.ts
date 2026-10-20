// STUB — replaced by feat/audio-core on merge
// Only here so feat/audio-tools type-checks on its own. The real module (stores, ffmpeg processor, service,
// backend selection) lives on feat/audio-core; take that version wholesale when merging.
import type { Logger } from "../logger.js";
import type { AudioLimits, AudioProcessor, MediaService, MediaStore } from "./types.js";

export * from "./types.js";

export interface MediaBackend {
  mode: "gcs" | "local";
  store: MediaStore;
  processor: AudioProcessor;
  limits: AudioLimits;
}

export interface MediaServiceOptions {
  store: MediaStore;
  processor: AudioProcessor;
  limits?: Partial<AudioLimits>;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createMediaBackend(_env: NodeJS.ProcessEnv, _log: Logger): MediaBackend {
  throw new Error("not implemented");
}

export function createMediaService(_opts: MediaServiceOptions): MediaService {
  throw new Error("not implemented");
}
