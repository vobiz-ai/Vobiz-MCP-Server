/**
 * Audio library for reminder calls: a user's own recordings or sounds, played with <Play> before the
 * spoken message. Shared contracts between the media module (src/media/*), the MCP tools and the
 * hosted connector.
 *
 * Files are private, one library per Vobiz account, and are served to Vobiz only through this server
 * at GET /media/:token (a short-lived sealed token), never from a public bucket URL.
 */

export interface AudioMeta {
  /** URL-safe id, e.g. a_7Fk2…; unique per account. */
  id: string;
  /** Account owner (Auth ID). Never exposed to other accounts. */
  authId: string;
  /** Display name chosen by the user, 1..80 chars, unique per account (case-insensitive). */
  name: string;
  /** Duration of the stored (converted) audio in seconds, rounded to 0.1. */
  durationSec: number;
  /** Size of the stored (converted) file in bytes. */
  bytes: number;
  /** Stored format after conversion: always 8 kHz mono 16-bit PCM WAV. */
  contentType: "audio/wav";
  /** Where it came from: an upload link, a URL import, or a phone recording. */
  source: "upload" | "url" | "phone";
  /** Original file name or URL (informational; no credentials). */
  origin?: string;
  createdAt: string;
}

export interface AudioLimits {
  /** Max accepted input size in bytes (before conversion). */
  maxInputBytes: number;
  /** Max accepted duration in seconds. */
  maxDurationSec: number;
  /** Max library entries per account. */
  maxPerAccount: number;
  /** Max uploads (+ imports) per account per UTC day. */
  maxUploadsPerDay: number;
}

/** Durable file + metadata storage. Implementations: LocalDiskMediaStore (dev, tests) and GcsMediaStore (hosted). */
export interface MediaStore {
  /** Stores the converted WAV bytes and metadata. Overwrites an existing id. */
  put(meta: AudioMeta, wav: Buffer): Promise<void>;
  getMeta(authId: string, id: string): Promise<AudioMeta | undefined>;
  /** Readable stream of the stored WAV, or undefined when missing. */
  open(authId: string, id: string): Promise<NodeJS.ReadableStream | undefined>;
  /** Newest first. */
  list(authId: string): Promise<AudioMeta[]>;
  delete(authId: string, id: string): Promise<boolean>;
}

export interface ProcessedAudio {
  wav: Buffer;
  durationSec: number;
}

/**
 * Validates and converts any input the user gives (mp3, wav, m4a, ogg/opus, webm, aac, flac…) to
 * 8 kHz mono 16-bit PCM WAV with ffmpeg. Rejects files with no audio stream, over the limits, or that
 * ffmpeg cannot decode. Never trusts the declared content type.
 */
export interface AudioProcessor {
  process(input: Buffer, limits: AudioLimits): Promise<ProcessedAudio>;
  /** True when ffmpeg and ffprobe are available on this machine. */
  available(): Promise<boolean>;
}

/** Sealed into an upload link token ("upl"). One token = one upload for one account. */
export interface UploadPayload {
  authId: string;
  /** Random id so the token can be marked used (replay protection). */
  jti: string;
}

/** Sealed into a media URL token ("med") handed to Vobiz in <Play>. */
export interface MediaUrlPayload {
  authId: string;
  id: string;
}

export interface MediaService {
  readonly limits: AudioLimits;
  /** Adds a processed file to the account's library. `name` must be unique per account; throws invalid_input / not_allowed. */
  add(authId: string, input: Buffer, o: { name: string; source: AudioMeta["source"]; origin?: string }): Promise<AudioMeta>;
  /** Downloads an https URL (size-capped, redirects limited, private hosts refused) and adds it. */
  importFromUrl(authId: string, url: string, name: string): Promise<AudioMeta>;
  list(authId: string): Promise<AudioMeta[]>;
  /** Looks up by id or by name (case-insensitive). */
  find(authId: string, idOrName: string): Promise<AudioMeta | undefined>;
  delete(authId: string, idOrName: string): Promise<AudioMeta | undefined>;
  /** Opens the stored WAV for streaming (GET /media/:token). */
  open(authId: string, id: string): Promise<{ meta: AudioMeta; stream: NodeJS.ReadableStream } | undefined>;
}
