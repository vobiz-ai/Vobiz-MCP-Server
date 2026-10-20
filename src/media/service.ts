/**
 * The per-account audio library: validation, caps, conversion and URL import on top of a MediaStore.
 *
 * Errors are VobizError kinds; `status` carries the HTTP code the upload router should answer with
 * (400 bad name / input, 403 caps, 413 too large or too long, 415 not audio, 502 import fetch failed).
 * Logs carry ids and error kinds only, never names, URLs or audio.
 */
import { randomBytes } from "node:crypto";
import { VobizError } from "../errors.js";
import type { Logger } from "../logger.js";
import { isPrivateHost } from "../util.js";
import { isValidAudioId } from "./store.js";
import type { AudioLimits, AudioMeta, AudioProcessor, MediaService, MediaStore } from "./types.js";

export const DEFAULT_AUDIO_LIMITS: AudioLimits = {
  maxInputBytes: 15 * 1024 * 1024,
  maxDurationSec: 300,
  maxPerAccount: 50,
  maxUploadsPerDay: 20,
};

export const IMPORT_TIMEOUT_MS = 15_000;
export const IMPORT_MAX_REDIRECTS = 3;
const NAME_MAX = 80;
const ORIGIN_MAX = 300;
const NAME_RE = /^[\p{L}\p{M}\p{N} ._()-]+$/u;

export interface MediaServiceOptions {
  store: MediaStore;
  processor: AudioProcessor;
  limits?: Partial<AudioLimits>;
  log: Logger;
  /** For URL imports (tests inject a fake). Default global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** URL import timeout, default 15 s. */
  importTimeoutMs?: number;
}

/** Trims and validates a library name; throws invalid_input. */
export function normalizeAudioName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new VobizError("invalid_input", "Give the audio a name (1 to 80 characters).", 400);
  if (name.length > NAME_MAX) throw new VobizError("invalid_input", `The audio name must be at most ${NAME_MAX} characters.`, 400);
  if (!NAME_RE.test(name)) {
    throw new VobizError("invalid_input", "The audio name may contain only letters, digits, spaces and - _ . ( ).", 400);
  }
  return name;
}

const newId = () => `a_${randomBytes(12).toString("base64url")}`;
const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The URL without query string, fragment or credentials (informational origin). */
function originOf(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}`.slice(0, ORIGIN_MAX);
}

function checkImportUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new VobizError("invalid_input", "The audio link is not a valid URL.", 400);
  }
  if (u.protocol !== "https:") throw new VobizError("invalid_input", "The audio link must start with https://.", 400);
  if (u.username || u.password) throw new VobizError("invalid_input", "The audio link must not contain credentials.", 400);
  if (isPrivateHost(u.hostname)) throw new VobizError("not_allowed", "The audio link must be a public internet address.", 403);
  return u;
}

export function createMediaService(o: MediaServiceOptions): MediaService {
  const limits: AudioLimits = { ...DEFAULT_AUDIO_LIMITS, ...o.limits };
  const { store, processor, log } = o;
  const now = o.now ?? (() => new Date());
  const fetchImpl = o.fetchImpl ?? fetch;
  const importTimeoutMs = o.importTimeoutMs ?? IMPORT_TIMEOUT_MS;

  /** Name and cap checks that do not need the audio; run before any download or conversion. */
  async function precheck(authId: string, rawName: unknown): Promise<string> {
    const name = normalizeAudioName(rawName);
    const existing = await store.list(authId);
    if (existing.some((m) => sameName(m.name, name))) {
      throw new VobizError("invalid_input", `An audio named "${name}" already exists. Pick another name or delete the old one first.`, 400);
    }
    if (existing.length >= limits.maxPerAccount) {
      throw new VobizError("not_allowed", `The audio library is full (${limits.maxPerAccount} files). Delete one before adding another.`, 403);
    }
    const today = now().toISOString().slice(0, 10);
    if (existing.filter((m) => m.createdAt.slice(0, 10) === today).length >= limits.maxUploadsPerDay) {
      throw new VobizError("not_allowed", `Daily limit reached: at most ${limits.maxUploadsPerDay} audio files can be added per day. Try again tomorrow (UTC).`, 403);
    }
    return name;
  }

  async function add(authId: string, input: Buffer, a: { name: string; source: AudioMeta["source"]; origin?: string }): Promise<AudioMeta> {
    const name = await precheck(authId, a.name);
    const { wav, durationSec } = await processor.process(input, limits);
    const meta: AudioMeta = {
      id: newId(),
      authId,
      name,
      durationSec,
      bytes: wav.length,
      contentType: "audio/wav",
      source: a.source,
      createdAt: now().toISOString(),
    };
    const origin = typeof a.origin === "string" ? a.origin.trim().slice(0, ORIGIN_MAX) : "";
    if (origin) meta.origin = origin;
    try {
      await store.put(meta, wav);
    } catch (e) {
      log.info(`media: store write failed (${e instanceof Error ? e.name : "error"})`);
      throw new VobizError("internal_error", "The audio could not be saved. Try again.", 500);
    }
    log.info(`media: added ${meta.id} (${meta.source}, ${durationSec}s)`);
    return meta;
  }

  async function download(start: URL): Promise<Buffer> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), importTimeoutMs);
    try {
      let url = start;
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        try {
          res = await fetchImpl(url, { redirect: "manual", signal: ac.signal, headers: { Accept: "audio/*, application/octet-stream;q=0.9, */*;q=0.5" } });
        } catch {
          throw ac.signal.aborted
            ? new VobizError("invalid_input", "The audio link took too long to download.", 504)
            : new VobizError("invalid_input", "The audio link could not be reached.", 502);
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          await res.body?.cancel().catch(() => undefined);
          if (hop >= IMPORT_MAX_REDIRECTS) throw new VobizError("invalid_input", "The audio link redirects too many times.", 400);
          let next: URL;
          try {
            next = new URL(res.headers.get("location")!, url);
          } catch {
            throw new VobizError("invalid_input", "The audio link redirects to an invalid address.", 400);
          }
          url = checkImportUrl(next.href);
          continue;
        }
        break;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new VobizError("invalid_input", `The audio link answered HTTP ${res.status}. Use a public link that downloads the file directly.`, 502);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxInputBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw tooLarge(limits);
      }
      if (!res.body) throw new VobizError("invalid_input", "The audio link returned no data.", 502);
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limits.maxInputBytes) {
            ac.abort();
            throw tooLarge(limits);
          }
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e instanceof VobizError) throw e;
        throw ac.signal.aborted
          ? new VobizError("invalid_input", "The audio link took too long to download.", 504)
          : new VobizError("invalid_input", "The audio download was interrupted.", 502);
      } finally {
        reader.releaseLock?.();
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timer);
    }
  }

  async function find(authId: string, idOrName: string): Promise<AudioMeta | undefined> {
    const key = typeof idOrName === "string" ? idOrName.trim() : "";
    if (!key) return undefined;
    if (isValidAudioId(key)) {
      const byId = await store.getMeta(authId, key);
      if (byId) return byId;
    }
    const wanted = key.replace(/\s+/g, " ");
    return (await store.list(authId)).find((m) => sameName(m.name, wanted));
  }

  return {
    limits,
    add,
    async importFromUrl(authId, rawUrl, name) {
      const u = checkImportUrl(typeof rawUrl === "string" ? rawUrl.trim() : "");
      await precheck(authId, name);
      const body = await download(u);
      return add(authId, body, { name, source: "url", origin: originOf(u) });
    },
    list: (authId) => store.list(authId),
    find,
    async delete(authId, idOrName) {
      const m = await find(authId, idOrName);
      if (!m) return undefined;
      if (!(await store.delete(authId, m.id))) return undefined;
      log.info(`media: deleted ${m.id}`);
      return m;
    },
    async open(authId, id) {
      const meta = await store.getMeta(authId, id);
      if (!meta) return undefined;
      const stream = await store.open(authId, id);
      return stream ? { meta, stream } : undefined;
    },
  };
}

function tooLarge(limits: AudioLimits): VobizError {
  return new VobizError("invalid_input", `The audio file is larger than ${Math.floor(limits.maxInputBytes / (1024 * 1024))} MB.`, 413);
}
