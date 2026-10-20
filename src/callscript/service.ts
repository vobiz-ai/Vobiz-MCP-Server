/**
 * Call-script rules and VobizXML. Pure functions apart from sealing: no I/O, every user string escaped by the XML
 * builder (src/xml.ts).
 */
import { VobizError } from "../errors.js";
import type { Sealer } from "../sealer.js";
import { isPrivateHostLiteral } from "../util.js";
import { buildResponseXml, type XmlAction } from "../xml.js";
import type { CallScript, CallScriptUrls } from "./types.js";

/** Ring (45 s) + up to 10 minutes of audio + Vobiz retries of the answer URL. */
export const SCRIPT_TTL_SEC = 20 * 60;
export const SAY_MAX_CHARS = 600;
export const LOOP_MAX = 10;
export const PLAY_URL_MAX = 2048;

export const INACTIVE_CALL_TEXT = "This call is no longer active.";
export const AUDIO_GONE_TEXT = "The audio file is no longer available.";
export const PAGE_LINK_MESSAGE =
  "`play` must be a direct link to an .mp3 or .wav file (for example https://example.com/track.mp3). " +
  "Pages from Pixabay, YouTube, Spotify or SoundCloud cannot be played; ask the user for a direct file link, " +
  "use import_audio_from_url with a direct link, or create_audio_upload_link so they can upload the file.";

const TOKEN_RE = /^vbzs_[A-Za-z0-9_-]{20,8000}$/;
const trimBase = (b: string) => b.replace(/\/+$/, "");

/** Strips control characters (newlines, tabs, NUL…) and collapses whitespace. */
export function cleanSayText(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** True when `play` should be read as a link rather than an audio-library name or id. */
export function looksLikeUrl(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) || /^www\./i.test(raw.trim());
}

/**
 * Validates an external `play` link: https, no credentials, a public host (literal check; Vobiz fetches it, not this
 * server), a path ending in .mp3 or .wav, at most 2048 characters. Throws invalid_input / not_allowed.
 */
export function checkPlayUrl(raw: string): string {
  const s = raw.trim();
  if (s.length > PLAY_URL_MAX) throw new VobizError("invalid_input", `\`play\` URL is longer than ${PLAY_URL_MAX} characters.`);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new VobizError("invalid_input", PAGE_LINK_MESSAGE);
  }
  if (u.protocol !== "https:") throw new VobizError("invalid_input", "`play` must use https.");
  if (u.username || u.password) throw new VobizError("invalid_input", "`play` must not contain credentials.");
  if (isPrivateHostLiteral(u.hostname)) throw new VobizError("not_allowed", "`play` must be on a public internet address that Vobiz can reach.");
  if (!/\.(mp3|wav)$/i.test(u.pathname)) throw new VobizError("invalid_input", PAGE_LINK_MESSAGE);
  return u.href;
}

/** With loop 0 the audio never ends, so speech has to come first to be heard at all. */
export function effectiveOrder(s: Pick<CallScript, "say" | "play" | "loop" | "order">): CallScript["order"] {
  return s.say && s.play && s.loop === 0 ? "say_then_play" : s.order;
}

/**
 * The answered call. `playUrl` is the URL to put in <Play> (external, or a freshly minted /media URL); "missing"
 * means the library file is gone, which is said instead of played.
 */
export function scriptXml(s: CallScript, playUrl: string | "missing" | undefined): string {
  const speak = (text: string, loop?: number): XmlAction => ({
    type: "speak",
    text,
    ...(s.say?.voice ? { voice: s.say.voice } : {}),
    ...(s.say?.language ? { language: s.say.language } : {}),
    ...(loop !== undefined && loop !== 1 ? { loop } : {}),
  });
  const audio: XmlAction[] =
    playUrl === undefined ? [] : playUrl === "missing" ? [speak(AUDIO_GONE_TEXT)] : [{ type: "play", url: playUrl, loop: s.loop }];
  const said: XmlAction[] = s.say ? [speak(s.say.text, s.play ? undefined : s.loop)] : [];
  const body = effectiveOrder(s) === "say_then_play" ? [...said, ...audio] : [...audio, ...said];
  return buildResponseXml([...body, { type: "hangup" }], {
    checkUrl: () => {
      // No call-control URLs (Gather/Redirect/Record) are ever emitted here.
    },
    checkDestination: () => {
      // A call script only plays or speaks; it never dials, so no destination can reach this hook.
      throw new Error("call scripts never emit Dial");
    },
  });
}

/** Answer XML for an unknown, malformed or expired token. Never a 4xx: Vobiz would just drop the call. */
export function inactiveCallXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Speak>${INACTIVE_CALL_TEXT}</Speak>\n    <Hangup/>\n</Response>\n`;
}

export function mintScriptUrls(sealer: Sealer, baseUrl: string, script: CallScript): CallScriptUrls {
  const token = sealer.seal("scr", { ...script }, SCRIPT_TTL_SEC);
  const base = trimBase(baseUrl);
  return { answerUrl: `${base}/c/${token}/answer`, hangupUrl: `${base}/c/${token}/hangup` };
}

/** The script behind a token, or undefined when the token is malformed, forged or expired. */
export function openScript(sealer: Sealer, token: string): CallScript | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  const s = sealer.open<CallScript>("scr", token);
  if (!s || typeof s.authId !== "string" || !s.authId) return undefined;
  if (!s.say && !s.play) return undefined;
  return s;
}
