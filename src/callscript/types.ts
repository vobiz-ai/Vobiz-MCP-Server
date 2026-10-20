/**
 * One-off call scripts for make_call: "call me and play this track" / "call me and say …".
 *
 * make_call seals the script into a "scr" token (vbzs_…) and hands Vobiz /c/:token/answer as the answer URL, so
 * this server returns the VobizXML when the call is answered (Play and/or Speak, then Hangup). Nothing is stored:
 * the token is the whole state, like reminder calls (/r/:token/*) and audio URLs (/media/:token).
 */
import type { Router } from "express";
import type { SPEAK_LANGS } from "../xml.js";

export type CallScriptOrder = "play_then_say" | "say_then_play";
export type SpeakLang = (typeof SPEAK_LANGS)[number];

export interface CallScriptSay {
  /** 1..600 characters, control characters stripped. */
  text: string;
  language?: SpeakLang;
  voice?: "WOMAN" | "MAN";
}

/** An external https .mp3/.wav URL (validated when the call was placed), or a file in the account's audio library. */
export type CallScriptPlay = { url: string } | { audioId: string; name: string };

export interface CallScript {
  /** Account owner (Auth ID). */
  authId: string;
  /**
   * The account's Auth Token, sealed with the script (AES-256-GCM, never logged) so Vobiz callback signatures can be
   * verified, exactly as reminder answer tokens do. Optional: without it every callback counts as unsigned.
   */
  authToken?: string;
  say?: CallScriptSay;
  play?: CallScriptPlay;
  /** Play count for the audio (or Speak count when there is no audio): 0..10, 0 = repeat until hangup. Default 1. */
  loop: number;
  order: CallScriptOrder;
}

export interface CallScriptUrls {
  /** Answer URL for Vobiz (POST): returns the script's VobizXML. */
  answerUrl: string;
  /** Hangup URL for Vobiz (POST): acknowledged and logged without PII. */
  hangupUrl: string;
}

export interface CallScriptBackend {
  /** Express router serving /c/:token/answer and /c/:token/hangup; mount at the app root. */
  router: Router;
  /** Seals a script and returns the URLs to put on the call. */
  mint(script: CallScript): CallScriptUrls;
}
