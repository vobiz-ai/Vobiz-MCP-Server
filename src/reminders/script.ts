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
  return `Press 1 to snooze for ${minutes(snoozeMinutes)}, 2 to confirm, 9 to stop these calls.`;
}

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

function gather(r: ScriptReminder, actionUrl: string, text: string): string[] {
  return [
    // finishOnKey must be a digit, *, # or "none": the media server rejects an empty string (hangup 8011 Invalid Answer XML).
    `<Gather action="${escapeXml(actionUrl)}" method="POST" inputType="dtmf" numDigits="1" finishOnKey="none" executionTimeout="10">`,
    `    ${speak(r, text)}`,
    `</Gather>`,
  ];
}

/** The answered call: optional audio, intro + message + menu inside a Gather, then the no-response line. */
export function answerScript(r: ScriptReminder, o: { actionUrl: string; retryInMinutes: number | null }): string {
  const text = `${INTROS[r.kind]} ${r.message.trim()} ${menuText(r.snoozeMinutes)}`;
  return doc([
    ...(r.audioUrl ? [`<Play>${escapeXml(r.audioUrl)}</Play>`] : []),
    ...gather(r, o.actionUrl, text),
    speak(r, noResponseText(o.retryInMinutes)),
  ]);
}

/** After an invalid key: repeat the message and menu once. */
export function repromptScript(r: ScriptReminder, o: { actionUrl: string; retryInMinutes: number | null }): string {
  return doc([
    ...gather(r, o.actionUrl, `Sorry, that is not an option. ${r.message.trim()} ${menuText(r.snoozeMinutes)}`),
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
