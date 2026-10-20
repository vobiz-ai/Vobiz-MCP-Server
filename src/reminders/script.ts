/**
 * VobizXML for reminder calls. Pure functions: no I/O, every user-supplied string escaped.
 * Times are never spoken (SSML say-as is undocumented on Vobiz); minutes are said as plain numbers.
 */
import { escapeXml } from "../xml.js";
import type { ReminderKind } from "./types.js";

export interface ScriptReminder {
  kind: ReminderKind;
  message: string;
  language: string;
  voice: "WOMAN" | "MAN";
  snoozeMinutes: number;
  audioUrl?: string;
}

export const INTROS: Record<ReminderKind, string> = {
  wake_up: "Good morning! This is your Vobiz wake-up call.",
  reminder: "Hello. This is your reminder call from Vobiz.",
};

export const INACTIVE_TEXT = "This reminder is no longer active.";

const minutes = (n: number) => `${n} ${n === 1 ? "minute" : "minutes"}`;

export function menuText(snoozeMinutes: number): string {
  return `Press 1 or say snooze to call again in ${minutes(snoozeMinutes)}. Press 2 or say confirm. Press 9 or say stop to end these calls.`;
}

/** Words the speech recogniser is primed with (Gather hints). */
export const SPEECH_HINTS = "snooze, later, confirm, yes, done, okay, stop, cancel, no";

/** What the call says when nobody presses a key: mentions the retry only when one will happen. */
export function noResponseText(retryInMinutes: number | null): string {
  return retryInMinutes ? `No response. I will call again in ${minutes(retryInMinutes)}. Goodbye.` : "No response. Goodbye.";
}

function doc(lines: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${lines.map((l) => "    " + l).join("\n")}\n</Response>\n`;
}

function speak(r: Pick<ScriptReminder, "language" | "voice">, text: string): string {
  return `<Speak language="${escapeXml(r.language)}" voice="${escapeXml(r.voice)}">${escapeXml(text)}</Speak>`;
}

/** Short menu for the second listening window. */
export function shortMenuText(): string {
  return "Press 1 or say snooze. Press 2 or say confirm. Press 9 or say stop.";
}

/**
 * A Gather around the given prompts: a key press OR a spoken word counts, during the prompts and for `timeoutSec` of
 * silence after them. Speech is the fallback for routes that do not relay DTMF. finishOnKey must be a digit, *, # or
 * "none": the media server rejects an empty string (hangup 8011 Invalid Answer XML).
 */
function gather(r: Pick<ScriptReminder, "language">, actionUrl: string, prompts: string[], timeoutSec: number): string[] {
  return [
    `<Gather action="${escapeXml(actionUrl)}" method="POST" inputType="dtmf speech" numDigits="1" finishOnKey="none" executionTimeout="${timeoutSec}" speechModel="command_and_search" language="${escapeXml(r.language)}" hints="${SPEECH_HINTS}">`,
    ...prompts.map((p) => `    ${p}`),
    `</Gather>`,
  ];
}

/**
 * The answered call. The optional audio sits INSIDE the first Gather so a key pressed while it plays still counts; a
 * second, short Gather gives a quiet window in case presses during playback were missed; then the no-response line.
 */
export function answerScript(r: ScriptReminder, o: { actionUrl: string; retryInMinutes: number | null }): string {
  const text = `${INTROS[r.kind]} ${r.message.trim()} ${menuText(r.snoozeMinutes)}`;
  return doc([
    ...gather(r, o.actionUrl, [...(r.audioUrl ? [`<Play>${escapeXml(r.audioUrl)}</Play>`] : []), speak(r, text)], 8),
    ...gather(r, o.actionUrl, [speak(r, shortMenuText())], 8),
    speak(r, noResponseText(o.retryInMinutes)),
  ]);
}

/** After an invalid key: repeat the message and menu once, with the same second window. */
export function repromptScript(r: ScriptReminder, o: { actionUrl: string; retryInMinutes: number | null }): string {
  return doc([
    ...gather(r, o.actionUrl, [speak(r, `Sorry, that is not an option. ${r.message.trim()} ${menuText(r.snoozeMinutes)}`)], 8),
    ...gather(r, o.actionUrl, [speak(r, shortMenuText())], 8),
    speak(r, noResponseText(o.retryInMinutes)),
  ]);
}

export function snoozedScript(r: Pick<ScriptReminder, "language" | "voice">, snoozeMinutes: number): string {
  return doc([speak(r, `Snoozed. I will call you again in ${minutes(snoozeMinutes)}. Goodbye.`), "<Hangup/>"]);
}

/** Snooze refused because the reminder reached its attempt ceiling. */
export function snoozeLimitScript(r: Pick<ScriptReminder, "language" | "voice">): string {
  return doc([speak(r, "This reminder cannot be snoozed again. Goodbye."), "<Hangup/>"]);
}

export function confirmedScript(r: Pick<ScriptReminder, "language" | "voice">): string {
  return doc([speak(r, "Thank you. Your reminder is confirmed. Goodbye."), "<Hangup/>"]);
}

export function stoppedScript(r: Pick<ScriptReminder, "language" | "voice">): string {
  return doc([speak(r, "OK. I will not call you about this again. Goodbye."), "<Hangup/>"]);
}

/** Second invalid key press: end the call. */
export function goodbyeScript(r: Pick<ScriptReminder, "language" | "voice">, retryInMinutes: number | null): string {
  const text = retryInMinutes ? `I will call again in ${minutes(retryInMinutes)}. Goodbye.` : "Goodbye.";
  return doc([speak(r, text), "<Hangup/>"]);
}

/** Answer/input for an unknown, expired or finished reminder. */
export function inactiveScript(): string {
  return doc([`<Speak>${INACTIVE_TEXT}</Speak>`, "<Hangup/>"]);
}
