import { Readable } from "node:stream";
import { VobizError } from "../src/errors.js";
import type { AudioLimits, AudioMeta, MediaService } from "../src/media/types.js";

/**
 * In-memory MediaService for router, tool and hosted tests. No ffmpeg: the "converted" WAV is the input with a
 * RIFF prefix, and inputs starting with these markers fail the way the real service does:
 *   NOAUDIO  → invalid_input "No audio stream found in this file."
 *   TOOLONG  → invalid_input "The audio is longer than … seconds."
 */
export class FakeMedia implements MediaService {
  readonly limits: AudioLimits;
  readonly files = new Map<string, { meta: AudioMeta; wav: Buffer }>();
  readonly added: { authId: string; bytes: number; name: string; source: AudioMeta["source"]; origin?: string }[] = [];
  readonly imports: { authId: string; url: string; name: string }[] = [];
  /** Thrown by the next add/importFromUrl/open call, then cleared. */
  failNext?: Error;
  /** Milliseconds add() waits before resolving (concurrency tests). */
  delayMs = 0;
  private seq = 0;

  constructor(limits: Partial<AudioLimits> = {}) {
    this.limits = { maxInputBytes: 15 * 1024 * 1024, maxDurationSec: 300, maxPerAccount: 50, maxUploadsPerDay: 20, ...limits };
  }

  private take(): void {
    const e = this.failNext;
    if (e) {
      this.failNext = undefined;
      throw e;
    }
  }

  async add(authId: string, input: Buffer, o: { name: string; source: AudioMeta["source"]; origin?: string }): Promise<AudioMeta> {
    this.take();
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const name = o.name.trim();
    if (!/^[A-Za-z0-9 _.()-]{1,80}$/.test(name)) throw new VobizError("invalid_input", "The name may use letters, digits, spaces and - _ . ( ) only (1 to 80 characters).");
    const mine = [...this.files.values()].filter((f) => f.meta.authId === authId);
    if (mine.some((f) => f.meta.name.toLowerCase() === name.toLowerCase())) throw new VobizError("invalid_input", `An audio named "${name}" already exists. Pick another name or delete it first.`);
    if (mine.length >= this.limits.maxPerAccount) throw new VobizError("not_allowed", `This account already has ${mine.length} audio files (limit ${this.limits.maxPerAccount}). Delete one first.`);
    if (input.length > this.limits.maxInputBytes) throw new VobizError("invalid_input", "The file is larger than the upload limit.");
    const head = input.subarray(0, 8).toString("latin1");
    if (head.startsWith("NOAUDIO")) throw new VobizError("invalid_input", "No audio stream found in this file.");
    if (head.startsWith("TOOLONG")) throw new VobizError("invalid_input", `The audio is longer than ${this.limits.maxDurationSec} seconds.`);
    const wav = Buffer.concat([Buffer.from("RIFF"), input]);
    const meta: AudioMeta = {
      id: `a_fake${String(++this.seq).padStart(12, "0")}`,
      authId,
      name,
      durationSec: input.length / 10, // 18 bytes → 1.8 s
      bytes: wav.length,
      contentType: "audio/wav",
      source: o.source,
      ...(o.origin ? { origin: o.origin } : {}),
      createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, this.seq)).toISOString(),
    };
    this.files.set(`${authId}/${meta.id}`, { meta, wav });
    this.added.push({ authId, bytes: input.length, name, source: o.source, ...(o.origin ? { origin: o.origin } : {}) });
    return { ...meta };
  }

  async importFromUrl(authId: string, url: string, name: string): Promise<AudioMeta> {
    this.take();
    this.imports.push({ authId, url, name });
    if (!url.startsWith("https://")) throw new VobizError("invalid_input", "The audio URL must use https.");
    const u = new URL(url);
    return this.add(authId, Buffer.from(`imported ${u.pathname}`), { name, source: "url", origin: u.origin + u.pathname });
  }

  async list(authId: string): Promise<AudioMeta[]> {
    return [...this.files.values()].filter((f) => f.meta.authId === authId).map((f) => ({ ...f.meta })).reverse();
  }

  async find(authId: string, idOrName: string): Promise<AudioMeta | undefined> {
    const k = idOrName.trim().toLowerCase();
    const hit = [...this.files.values()].find((f) => f.meta.authId === authId && (f.meta.id.toLowerCase() === k || f.meta.name.toLowerCase() === k));
    return hit ? { ...hit.meta } : undefined;
  }

  async delete(authId: string, idOrName: string): Promise<AudioMeta | undefined> {
    const m = await this.find(authId, idOrName);
    if (m) this.files.delete(`${authId}/${m.id}`);
    return m;
  }

  async open(authId: string, id: string): Promise<{ meta: AudioMeta; stream: NodeJS.ReadableStream } | undefined> {
    this.take();
    const f = this.files.get(`${authId}/${id}`);
    return f ? { meta: { ...f.meta }, stream: Readable.from([f.wav]) } : undefined;
  }
}
