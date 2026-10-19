/**
 * Validated builder for Vobiz call-control XML, limited to the verbs and attributes documented in
 * mintlify-docs xml/*.mdx: Response, Speak, Play, Wait, Gather, Record, Dial (Number/User), Redirect, Hangup.
 * Live-core quirks from masking-service/internal/vobizxml/xml.go are respected: Record always carries an
 * explicit redirect attribute (the core defaults it to true, unlike the docs).
 */
import { z } from "zod";
import { VobizError } from "./errors.js";

export const SPEAK_LANGS = [
  "da-DK", "nl-NL", "en-AU", "en-GB", "en-US", "en-IN", "fr-FR", "fr-CA", "de-DE", "it-IT",
  "pl-PL", "pt-PT", "pt-BR", "ru-RU", "es-ES", "es-US", "sv-SE", "hi-IN",
] as const;

const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "must use https");
const audio = httpsUrl.refine((u) => {
  try {
    return /\.(mp3|wav)$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
}, "must point to an .mp3 or .wav file");
const method = z.enum(["GET", "POST"]).optional();
const finishKey = z.enum(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "none"]);

const speak = z.object({
  type: z.literal("speak"),
  text: z.string().trim().min(1).max(3000),
  voice: z.enum(["WOMAN", "MAN"]).optional(),
  language: z.enum(SPEAK_LANGS).optional(),
  loop: z.number().int().min(0).max(100).optional().describe("0 = repeat until something else happens"),
});
const play = z.object({ type: z.literal("play"), url: audio, loop: z.number().int().min(0).max(100).optional() });
const wait = z.object({
  type: z.literal("wait"),
  length: z.number().int().min(1).max(3600),
  silence: z.boolean().optional(),
  min_silence_ms: z.number().int().min(100).max(60000).optional(),
  beep: z.boolean().optional(),
});
const gather = z.object({
  type: z.literal("gather"),
  action_url: httpsUrl.optional().describe("Where Vobiz posts Digits. Omit to use this server's hosted callback (HTTP mode)."),
  method,
  input_type: z.enum(["dtmf", "speech", "dtmf speech"]).optional(),
  num_digits: z.number().int().min(1).max(32).optional(),
  execution_timeout: z.number().int().min(5).max(60).optional().describe("Seconds to wait for input after the prompt (default 15)"),
  digit_end_timeout: z.union([z.number().int().min(2).max(10), z.literal("auto")]).optional(),
  finish_on_key: finishKey.optional(),
  language: z.enum(SPEAK_LANGS).optional(),
  redirect: z.boolean().optional(),
  prompt: z.array(z.union([speak, play])).max(5).optional(),
});
const record = z.object({
  type: z.literal("record"),
  action_url: httpsUrl.describe("Required by the Vobiz core; receives RecordingID when recording starts."),
  method,
  file_format: z.enum(["mp3", "wav"]).optional(),
  max_length: z.number().int().min(1).max(14400).optional(),
  timeout: z.number().int().min(1).max(3600).optional().describe("Seconds of silence that end the recording"),
  play_beep: z.boolean().optional(),
  finish_on_key: z.string().regex(/^[0-9*#]{1,12}$/).optional(),
  redirect: z.boolean().optional().describe("Default false here (emitted explicitly)"),
  callback_url: httpsUrl.optional().describe("Receives RecordUrl/RecordingDuration when the recording stops"),
});
const dial = z.object({
  type: z.literal("dial"),
  number: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
  sip_uri: z.string().regex(/^sip:[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9.-]{1,253}$/).optional(),
  caller_id: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional(),
  timeout: z.number().int().min(5).max(120).optional(),
  time_limit: z.number().int().min(10).max(14400).optional(),
  action_url: httpsUrl.optional(),
  method,
});
const redirect = z.object({ type: z.literal("redirect"), url: httpsUrl, method });
const hangup = z.object({
  type: z.literal("hangup"),
  reason: z.enum(["rejected", "busy"]).optional(),
  schedule: z.number().int().min(1).max(86400).optional(),
});

export const xmlAction = z.discriminatedUnion("type", [speak, play, wait, gather, record, dial, redirect, hangup]);
export type XmlAction = z.infer<typeof xmlAction>;
export const xmlActions = z.array(xmlAction).min(1).max(20);

export const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);

function attrs(pairs: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
}

export interface BuildOptions {
  /** Validates call-control URLs (action/redirect/callback); throws when not allowed. */
  checkUrl: (url: string, field: string) => void;
  /** Default Gather action URL (hosted callback) when the action has none. */
  defaultGatherAction?: string;
}

function el(a: XmlAction, o: BuildOptions, indent: string): string {
  switch (a.type) {
    case "speak":
      return `${indent}<Speak${attrs({ voice: a.voice, language: a.language, loop: a.loop })}>${escapeXml(a.text)}</Speak>`;
    case "play":
      return `${indent}<Play${attrs({ loop: a.loop })}>${escapeXml(a.url)}</Play>`;
    case "wait":
      if (a.min_silence_ms !== undefined && !a.silence) throw new VobizError("invalid_input", "wait.min_silence_ms needs silence: true.");
      if (a.silence && a.min_silence_ms !== undefined && a.length * 1000 <= a.min_silence_ms) {
        throw new VobizError("invalid_input", "wait.length (seconds) must be longer than min_silence_ms.");
      }
      return `${indent}<Wait${attrs({ length: a.length, silence: a.silence, minSilence: a.min_silence_ms, beep: a.beep })}/>`;
    case "gather": {
      const action = a.action_url ?? o.defaultGatherAction;
      if (!action) throw new VobizError("invalid_input", "gather.action_url is required (no hosted callback is available in this mode).");
      if (a.action_url) o.checkUrl(a.action_url, "gather.action_url");
      const inner = (a.prompt ?? []).map((p) => el(p, o, indent + "    ")).join("\n");
      const open = `${indent}<Gather${attrs({
        action,
        method: a.method ?? "POST",
        inputType: a.input_type ?? "dtmf",
        numDigits: a.num_digits,
        executionTimeout: a.execution_timeout,
        digitEndTimeout: a.digit_end_timeout,
        finishOnKey: a.finish_on_key,
        language: a.language,
        redirect: a.redirect,
      })}`;
      return inner ? `${open}>\n${inner}\n${indent}</Gather>` : `${open}/>`;
    }
    case "record":
      o.checkUrl(a.action_url, "record.action_url");
      if (a.callback_url) o.checkUrl(a.callback_url, "record.callback_url");
      return `${indent}<Record${attrs({
        action: a.action_url,
        method: a.method ?? "POST",
        fileFormat: a.file_format,
        maxLength: a.max_length,
        timeout: a.timeout,
        playBeep: a.play_beep,
        finishOnKey: a.finish_on_key,
        redirect: a.redirect ?? false,
        callbackUrl: a.callback_url,
      })}/>`;
    case "dial": {
      if (!!a.number === !!a.sip_uri) throw new VobizError("invalid_input", "dial needs exactly one of number or sip_uri.");
      if (a.action_url) o.checkUrl(a.action_url, "dial.action_url");
      const target = a.number
        ? `${indent}    <Number>${escapeXml(a.number.startsWith("+") ? a.number : "+" + a.number)}</Number>`
        : `${indent}    <User>${escapeXml(a.sip_uri as string)}</User>`;
      return `${indent}<Dial${attrs({
        callerId: a.caller_id,
        timeout: a.timeout,
        timeLimit: a.time_limit,
        action: a.action_url,
        method: a.action_url ? (a.method ?? "POST") : undefined,
      })}>\n${target}\n${indent}</Dial>`;
    }
    case "redirect":
      o.checkUrl(a.url, "redirect.url");
      return `${indent}<Redirect${attrs({ method: a.method ?? "POST" })}>${escapeXml(a.url)}</Redirect>`;
    case "hangup":
      return `${indent}<Hangup${attrs({ reason: a.reason, schedule: a.schedule })}/>`;
  }
}

/** Builds a complete <Response> document. Throws invalid_input for unreachable or invalid sequences. */
export function buildResponseXml(actions: XmlAction[], o: BuildOptions): string {
  const parsed = xmlActions.safeParse(actions);
  if (!parsed.success) {
    throw new VobizError("invalid_input", `Invalid XML actions: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const list = parsed.data;
  list.forEach((a, i) => {
    const terminal = a.type === "redirect" || (a.type === "hangup" && a.schedule === undefined);
    if (terminal && i < list.length - 1) {
      throw new VobizError("invalid_input", `Action ${i + 1} (${a.type}) ends the flow, so the actions after it would never run.`);
    }
  });
  const body = list.map((a) => el(a, o, "    ")).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>\n`;
  if (Buffer.byteLength(xml) > 100_000) throw new VobizError("invalid_input", "The XML document exceeds Vobiz's 100 KB limit.");
  return xml;
}
