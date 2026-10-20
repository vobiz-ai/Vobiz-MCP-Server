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
import { isPrivateHostLiteral, resolvePublicHost, type HostLookup } from "../util.js";
import { pinnedRequest, type PinnedRequest } from "./fetch.js";
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
/** The only ports a URL import may use, on every hop. */
export const IMPORT_PORTS = ["", "443", "8443"];
/** The one message for every network or upstream HTTP failure (no upstream status or detail is echoed). */
export const IMPORT_FAILED = "The audio link could not be downloaded.";
const NAME_MAX = 80;
const ORIGIN_MAX = 300;
const NAME_RE = /^[\p{L}\p{M}\p{N} ._()-]+$/u;

export interface MediaServiceOptions {
  store: MediaStore;
  processor: AudioProcessor;
  limits?: Partial<AudioLimits>;
  log: Logger;
  /** One pinned GET per hop for URL imports (tests inject a fake). Default node:https pinned to the vetted address. */
  request?: PinnedRequest;
  /** DNS for URL imports (tests inject a fake). Default dns.promises.lookup({ all: true, verbatim: true }). */
  lookup?: HostLookup;
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
  if (!IMPORT_PORTS.includes(u.port)) throw new VobizError("invalid_input", "The audio link must use the standard https port (443).", 400);
  if (isPrivateHostLiteral(u.hostname)) throw notPublic();
  return u;
}

const notPublic = () => new VobizError("not_allowed", "The audio link must be a public internet address.", 403);
const importFailed = (status = 502) => new VobizError("invalid_input", IMPORT_FAILED, status);

export function createMediaService(o: MediaServiceOptions): MediaService {
  const limits: AudioLimits = { ...DEFAULT_AUDIO_LIMITS, ...o.limits };
  const { store, processor, log } = o;
  const now = o.now ?? (() => new Date());
  const requestImpl = o.request ?? pinnedRequest;
  const lookup = o.lookup;
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

  /**
   * GET with every hop vetted: https on 443/8443, no credentials, and every DNS answer public. The connection is
   * pinned to the first vetted address, so DNS rebinding between the check and the connect cannot redirect it.
   */
  async function download(start: URL): Promise<Buffer> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), importTimeoutMs);
    const failed = () => importFailed(ac.signal.aborted ? 504 : 502);
    try {
      let url = start;
      let res: Response | undefined;
      for (let hop = 0; ; hop++) {
        url = checkImportUrl(url.href);
        const vetted = await untilAborted(resolvePublicHost(url.hostname, lookup), ac.signal);
        if (!vetted) throw failed(); // DNS outlived the import timeout
        if (!vetted.ok) throw vetted.reason === "private" ? notPublic() : importFailed();
        const { address, family } = vetted.addresses[0];
        try {
          res = await requestImpl(url, { address, family, signal: ac.signal, headers: { Accept: "audio/*, application/octet-stream;q=0.9, */*;q=0.5" } });
        } catch {
          throw failed();
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          await res.body?.cancel().catch(() => undefined);
          if (hop >= IMPORT_MAX_REDIRECTS) throw importFailed();
          try {
            url = new URL(res.headers.get("location")!, url);
          } catch {
            throw importFailed();
          }
          continue;
        }
        break;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw importFailed();
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxInputBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw tooLarge(limits);
      }
      if (!res.body) throw importFailed();
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
        throw failed();
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

/** Resolves with `p`, or with undefined as soon as `signal` aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function tooLarge(limits: AudioLimits): VobizError {
  return new VobizError("invalid_input", `The audio file is larger than ${Math.floor(limits.maxInputBytes / (1024 * 1024))} MB.`, 413);
}
