/**
 * HTTP surface of the audio library:
 *   GET      /upload/:token   upload page (pick or drop a file, or record from the microphone)
 *   PUT      /upload/:token   raw audio body (the page, or `curl --data-binary` from a code sandbox) → 201 JSON
 *   GET|HEAD /media/:token    the stored 8 kHz WAV, fetched by Vobiz for <Play> on a reminder call
 *
 * Tokens are sealed by this server: "upl" (one account, one upload attempt, 15 minutes) and "med" (one file, 20 minutes:
 * the reminder service mints it when the call is answered, and Vobiz fetches it within seconds).
 * Nothing else authenticates these routes, so a token never appears in logs, and responses never echo it.
 * Every failure maps to a 4xx (or 503 when storage is down); log lines carry the error kind only.
 */
import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { BRAND_BASE_CSS, VOBIZ_LOGO_SVG, faviconLinkTag } from "../brand.js";
import type { Config } from "../config.js";
import { VobizError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Sealer } from "../sealer.js";
import type { AudioMeta, MediaService, MediaUrlPayload, UploadPayload } from "./types.js";

export const UPLOAD_TTL_SEC = 900;
export const MEDIA_TTL_SEC = 1200;
/** Longest recording the upload page makes. */
export const RECORD_MAX_SEC = 300;
/** The same rule the service applies; checked here first so a bad name never costs a conversion. */
export const AUDIO_NAME_RE = /^[\p{L}\p{N} _.()-]{1,80}$/u;

export interface MediaRouterOptions {
  /** Public base URL of this server, no trailing slash. */
  baseUrl: string;
  sealer: Sealer;
  log: Logger;
  links: Config["links"];
}

/** Upload-link payload: the account, a one-time id and an optional suggested name for the page. */
type UploadToken = UploadPayload & { name?: string };

const UPL_RE = /^vbzu_[A-Za-z0-9_-]{20,8000}$/;
const MED_RE = /^vbzm_[A-Za-z0-9_-]{20,8000}$/;
/** Used upload ids remembered per process (replay protection; the 15-minute TTL bounds it across restarts). */
const MAX_USED = 20_000;

const trimBase = (b: string) => b.replace(/\/+$/, "");

/** A one-time upload URL for this account: seal("upl", { authId, jti }, 15 min). */
export function mintUploadUrl(sealer: Sealer, baseUrl: string, authId: string, name?: string): string {
  const payload = { authId, jti: randomBytes(12).toString("base64url"), ...(name ? { name: name.slice(0, 80) } : {}) } satisfies UploadToken;
  return `${trimBase(baseUrl)}/upload/${sealer.seal("upl", payload, UPLOAD_TTL_SEC)}`;
}

/**
 * The URL handed to Vobiz in <Play>: seal("med", { authId, id }, 20 min), minted at answer time and never cached. The `.wav` suffix is for media servers that
 * pick the decoder from the extension; the route accepts the token with or without it.
 */
export function mintMediaUrl(sealer: Sealer, baseUrl: string, authId: string, id: string): string {
  return `${trimBase(baseUrl)}/media/${sealer.seal("med", { authId, id } satisfies MediaUrlPayload, MEDIA_TTL_SEC)}.wav`;
}

/** Normalised display name, or undefined when it breaks the naming rule. */
export function cleanAudioName(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return AUDIO_NAME_RE.test(s) ? s : undefined;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function decodeHeader(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string" || !s) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Original file name, informational only: last path segment, printable, at most 120 characters. */
function fileName(v: unknown): string | undefined {
  const s = decodeHeader(v)?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, 120) : undefined;
}

function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "media-src blob:",
    "img-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function shell(o: { title: string; body: string; nonce?: string; script?: string; links: Config["links"] }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(o.title)} · Vobiz MCP Server</title>${faviconLinkTag()}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&display=swap">
<style>
${BRAND_BASE_CSS}
label{display:block;font-weight:500;font-size:14px;margin:16px 0 6px}
.hint{display:block;font-weight:300;font-size:13px;color:var(--muted);margin:4px 0 0}
input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);background:var(--input);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=text]::placeholder{color:var(--muted);font-weight:300}
input[type=text]:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--ring)}
.drop{display:flex;flex-direction:column;align-items:center;gap:4px;margin:18px 0 0;padding:22px 16px;border:1.5px dashed var(--line);border-radius:var(--radius);text-align:center;color:var(--muted);font-size:14px;cursor:pointer;transition:border-color .15s,background .15s}
.drop strong{color:var(--fg);font-weight:500}
.drop:hover,.drop.over{border-color:var(--orange);background:color-mix(in srgb,var(--orange) 6%,transparent)}
.drop:has(input:focus-visible){box-shadow:0 0 0 3px var(--ring)}
.drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.or{display:flex;align-items:center;gap:12px;margin:16px 0 0;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
.rec{display:flex;align-items:center;gap:12px;margin:16px 0 0}
.rec button{margin:0;width:auto;flex:0 0 auto;padding:10px 16px;background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
.rec button:hover{background:transparent;border-color:var(--red)}
.rec button.on{border-color:var(--red);color:var(--red)}
.rec button.on::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-right:8px;vertical-align:1px}
.timer{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
.picked{margin:14px 0 0;font-size:14px;color:var(--muted);overflow-wrap:anywhere}
.picked strong{color:var(--fg);font-weight:500}
audio{width:100%;margin:10px 0 0}
progress{display:block;width:100%;height:6px;margin:18px 0 0;border:0;border-radius:3px;background:var(--line);overflow:hidden;accent-color:var(--red)}
progress::-webkit-progress-bar{background:var(--line)}
progress::-webkit-progress-value{background:linear-gradient(90deg,var(--orange),var(--red))}
progress::-moz-progress-bar{background:var(--red)}
button:disabled{opacity:.55;cursor:not-allowed}
.ok h2{font-weight:600;font-size:18px;margin:0 0 6px}
.ok p{margin:0;color:var(--muted)}
.ok code{color:var(--fg);font:500 14px "IBM Plex Sans",sans-serif}
[hidden]{display:none!important}
</style></head><body>
<div class="brand">${VOBIZ_LOGO_SVG}</div>
<main>
${o.body}
</main>
<footer><a href="${esc(o.links.privacy)}" target="_blank" rel="noopener">Privacy policy</a> · <a href="${esc(o.links.docs)}" target="_blank" rel="noopener">Documentation</a></footer>
${o.script && o.nonce ? `<script nonce="${o.nonce}">${o.script}</script>` : ""}
</body></html>`;
}

function expiredPage(links: Config["links"]): string {
  return shell({
    title: "Upload link expired",
    links,
    body: `<p class="eyebrow">Vobiz audio library</p>
<h1>This upload link has expired</h1>
<p class="lead">Upload links work once and for 15 minutes. Go back to your chat and ask for a new upload link.</p>`,
  });
}

/** Client script for the upload page. No external code; everything the page needs is inline. */
const UPLOAD_SCRIPT = `(function(){
var $=function(id){return document.getElementById(id)};
var form=$("f"),nameEl=$("name"),fileEl=$("file"),drop=$("drop"),recBtn=$("rec"),timer=$("timer"),picked=$("picked"),
preview=$("preview"),bar=$("bar"),err=$("err"),save=$("save"),done=$("done"),doneName=$("done-name"),doneSay=$("done-say");
var MAX=Number(form.dataset.max),CAP=Number(form.dataset.cap),RE=/^[\\p{L}\\p{N} _.()-]{1,80}$/u;
var blob=null,blobName="",rec=null,stream=null,t0=0,tick=null,chunks=[];
function fail(m){err.textContent=m;err.hidden=!m}
function mmss(s){s=Math.floor(s);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}
function suggest(n){if(nameEl.value.trim())return;var b=n.replace(/\\.[A-Za-z0-9]{1,5}$/,"").replace(/[^\\p{L}\\p{N} _.()-]+/gu," ").replace(/\\s+/g," ").trim().slice(0,80);if(b)nameEl.value=b}
function use(b,label,fname){blob=b;blobName=fname||"";fail("");picked.hidden=false;picked.innerHTML="";var s=document.createElement("strong");s.textContent=label;picked.append("Ready: ",s," (",(b.size/1048576).toFixed(1)," MB)");
if(preview.src)URL.revokeObjectURL(preview.src);preview.src=URL.createObjectURL(b);preview.hidden=false;if(b.size>MAX)fail("This file is larger than "+Math.round(MAX/1048576)+" MB. Choose a shorter or smaller file.")}
function pick(f){if(!f)return;if(f.type&&!/^audio\\/|^video\\/(webm|mp4|ogg)/.test(f.type)){fail("Choose an audio file (MP3, WAV, M4A, OGG, WEBM, AAC or FLAC).");return}suggest(f.name);use(f,f.name,f.name)}
fileEl.addEventListener("change",function(){pick(fileEl.files&&fileEl.files[0])});
["dragenter","dragover"].forEach(function(e){drop.addEventListener(e,function(ev){ev.preventDefault();drop.classList.add("over")})});
["dragleave","drop"].forEach(function(e){drop.addEventListener(e,function(ev){ev.preventDefault();drop.classList.remove("over")})});
drop.addEventListener("drop",function(ev){pick(ev.dataTransfer&&ev.dataTransfer.files[0])});
function stopRec(){if(rec&&rec.state!=="inactive")rec.stop()}
recBtn.addEventListener("click",function(){
if(rec&&rec.state==="recording"){stopRec();return}
if(!navigator.mediaDevices||!window.MediaRecorder){fail("This browser cannot record audio. Upload a file instead.");return}
navigator.mediaDevices.getUserMedia({audio:true}).then(function(s){
stream=s;chunks=[];var type=["audio/webm;codecs=opus","audio/ogg;codecs=opus","audio/mp4"].find(function(x){return MediaRecorder.isTypeSupported(x)});
rec=type?new MediaRecorder(s,{mimeType:type}):new MediaRecorder(s);
rec.ondataavailable=function(e){if(e.data&&e.data.size)chunks.push(e.data)};
rec.onstop=function(){clearInterval(tick);stream.getTracks().forEach(function(x){x.stop()});recBtn.classList.remove("on");recBtn.textContent="Record again";
var secs=(Date.now()-t0)/1000,b=new Blob(chunks,{type:rec.mimeType||"audio/webm"});if(!b.size){fail("Nothing was recorded. Check the microphone and try again.");return}
if(!nameEl.value.trim())nameEl.value="Recording "+new Date().toISOString().slice(0,16).replace("T"," ").replace(":",".");use(b,"Recording "+mmss(secs),"recording."+((b.type.split("/")[1]||"webm").split(";")[0]))};
rec.start(1000);t0=Date.now();fail("");recBtn.classList.add("on");recBtn.textContent="Stop";timer.textContent="0:00 / "+mmss(CAP);
tick=setInterval(function(){var e=(Date.now()-t0)/1000;timer.textContent=mmss(e)+" / "+mmss(CAP);if(e>=CAP)stopRec()},250)
}).catch(function(){fail("Microphone access was blocked. Allow it in the browser, or upload a file instead.")})});
form.addEventListener("submit",function(ev){
ev.preventDefault();stopRec();var n=nameEl.value.replace(/\\s+/g," ").trim();
if(!RE.test(n)){fail("Give the audio a name: up to 80 letters, digits, spaces and - _ . ( ).");nameEl.focus();return}
if(!blob){fail("Choose a file or record something first.");return}
if(blob.size>MAX){fail("This file is larger than "+Math.round(MAX/1048576)+" MB.");return}
fail("");save.disabled=true;save.textContent="Uploading…";bar.hidden=false;bar.removeAttribute("value");
var x=new XMLHttpRequest();x.open("PUT",location.pathname);x.setRequestHeader("Content-Type",blob.type||"application/octet-stream");
x.setRequestHeader("X-Audio-Name",encodeURIComponent(n));if(blobName)x.setRequestHeader("X-File-Name",encodeURIComponent(blobName));
x.upload.onprogress=function(e){if(e.lengthComputable){bar.max=e.total;bar.value=e.loaded;if(e.loaded>=e.total)save.textContent="Converting…"}};
x.onload=function(){var r={};try{r=JSON.parse(x.responseText)}catch(e){}
if(x.status===201){form.hidden=true;done.hidden=false;doneName.textContent=r.name||n;doneSay.textContent="use the audio "+(r.name||n);return}
bar.hidden=true;save.textContent="Link used";
fail(x.status===410?"This upload link has expired or was already used. Go back to your chat and ask for a new one.":(r.message||"The upload did not go through.")+" Each link works once: go back to your chat and ask for a new upload link.")};
x.onerror=function(){bar.hidden=true;save.disabled=false;save.textContent="Save audio";fail("The upload did not go through. Check your connection and try again.")};
x.send(blob)});
})();`;

function uploadPage(o: { name: string; maxBytes: number; maxDurationSec: number; links: Config["links"]; nonce: string }): string {
  const mb = Math.max(1, Math.round(o.maxBytes / 1048576));
  const cap = Math.min(RECORD_MAX_SEC, o.maxDurationSec);
  const minutes = Math.round((o.maxDurationSec / 60) * 10) / 10;
  return shell({
    title: "Add audio",
    links: o.links,
    nonce: o.nonce,
    script: UPLOAD_SCRIPT,
    body: `<p class="eyebrow">Vobiz audio library</p>
<h1>Add audio for your reminder calls</h1>
<p class="lead">Upload a file or record a message. It plays at the start of your reminder or wake-up call, before the spoken message.</p>
<form id="f" data-max="${o.maxBytes}" data-cap="${cap}" novalidate>
<label for="name">Name <span class="hint">You use this name in the chat, e.g. "Morning alarm".</span></label>
<input id="name" name="name" type="text" maxlength="80" value="${esc(o.name)}" placeholder="Morning alarm" autocomplete="off" spellcheck="false">
<label class="drop" id="drop" for="file"><strong>Choose an audio file</strong>or drop it here · MP3, WAV, M4A, OGG, WEBM, AAC, FLAC · up to ${mb} MB and ${minutes} minutes
<input id="file" type="file" accept="audio/*"></label>
<div class="or">or</div>
<div class="rec"><button type="button" id="rec">Record</button><span class="timer" id="timer">Up to ${Math.floor(cap / 60)}:${String(cap % 60).padStart(2, "0")}</span></div>
<p class="picked" id="picked" hidden></p>
<audio id="preview" controls hidden></audio>
<progress id="bar" hidden></progress>
<p class="err" id="err" role="alert" hidden></p>
<button type="submit" id="save">Save audio</button>
</form>
<div class="ok" id="done" hidden role="status">
<h2>Saved as <span id="done-name"></span></h2>
<p>Go back to your chat and say: <code id="done-say"></code></p>
</div>
<p class="fine">The audio is converted for phone calls and kept private to your Vobiz account. Vobiz fetches it only through a short-lived link when your reminder call is answered.</p>`,
  });
}

const audioView = (m: AudioMeta) => ({ id: m.id, name: m.name, duration_sec: m.durationSec, bytes: m.bytes });

/** HTTP status for an error from MediaService.add (never 500). */
function statusFor(err: unknown): { status: number; kind: string; message: string } {
  if (!(err instanceof VobizError)) return { status: 503, kind: "internal_error", message: "The upload could not be saved right now. Try again in a minute." };
  const m = err.message;
  switch (err.kind) {
    case "invalid_input":
      if (/\bname\b|already exists/i.test(m)) return { status: 400, kind: err.kind, message: m };
      if (/too large|larger than|\bMB\b|bytes/i.test(m)) return { status: 413, kind: err.kind, message: m };
      if (/too long|longer than|duration|seconds|minutes/i.test(m)) return { status: 400, kind: err.kind, message: m };
      return { status: 415, kind: err.kind, message: m };
    case "not_allowed":
      return { status: 403, kind: err.kind, message: m };
    case "rate_limited":
      return { status: 429, kind: err.kind, message: m };
    case "not_found":
      return { status: 404, kind: err.kind, message: m };
    default:
      return { status: 503, kind: err.kind, message: "The upload could not be saved right now. Try again in a minute." };
  }
}

export function createMediaRouter(service: MediaService, o: MediaRouterOptions): Router {
  const router = express.Router();
  const { sealer, log } = o;
  /** jti → token expiry (ms) of links that were used, or are being used by an upload in flight. */
  const used = new Map<string, number>();

  const prune = () => {
    const t = Date.now();
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    while (used.size >= MAX_USED) used.delete(used.keys().next().value as string);
  };

  const openUpload = (token: string): (UploadToken & { exp: number }) | undefined => {
    if (!UPL_RE.test(token)) return undefined;
    const p = sealer.open<UploadToken>("upl", token);
    if (!p || typeof p.authId !== "string" || !p.authId || typeof p.jti !== "string" || !p.jti) return undefined;
    return used.has(p.jti) ? undefined : p;
  };

  const noStore = (res: Response) =>
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" });

  router.get("/upload/:token", (req: Request, res: Response) => {
    noStore(res);
    const p = openUpload(String(req.params.token ?? ""));
    if (!p) {
      res.set("Content-Security-Policy", pageCsp(randomBytes(16).toString("base64")));
      return res.status(410).type("html").send(expiredPage(o.links));
    }
    const nonce = randomBytes(16).toString("base64");
    res.set({ "Content-Security-Policy": pageCsp(nonce), "Permissions-Policy": "microphone=(self), camera=(), geolocation=()" });
    return res
      .status(200)
      .type("html")
      .send(uploadPage({ name: cleanAudioName(p.name) ?? "", maxBytes: service.limits.maxInputBytes, maxDurationSec: service.limits.maxDurationSec, links: o.links, nonce }));
  });

  router.put(
    "/upload/:token",
    // Check the token before reading the body, so an expired link does not cost an upload.
    (req: Request, res: Response, next: NextFunction) => {
      noStore(res);
      if (!openUpload(String(req.params.token ?? ""))) {
        req.resume();
        return res.status(410).set("Connection", "close").json({ error: "link_expired", message: "This upload link has expired or was already used. Ask for a new upload link." });
      }
      next();
    },
    express.raw({ type: () => true, limit: service.limits.maxInputBytes }),
    async (req: Request, res: Response) => {
      const p = openUpload(String(req.params.token ?? ""));
      if (!p) return res.status(410).json({ error: "link_expired", message: "This upload link has expired or was already used. Ask for a new upload link." });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: "invalid_input", message: "The request body is empty. Send the audio file as the raw body." });
      const rawName = decodeHeader(req.headers["x-audio-name"]) ?? (typeof req.query.name === "string" ? req.query.name : undefined);
      const name = cleanAudioName(rawName);
      if (!name) {
        return res.status(400).json({ error: "invalid_input", message: "Give the audio a name (X-Audio-Name header or ?name=): 1 to 80 letters, digits, spaces and - _ . ( )." });
      }
      // Claim the link before the (slow) conversion so two concurrent uploads with one link cannot both land.
      // One link = one attempt: the claim is kept even when the upload fails (the attempt was counted).
      prune();
      used.set(p.jti, p.exp * 1000);
      try {
        const origin = fileName(req.headers["x-file-name"]);
        const meta = await service.add(p.authId, body, { name, source: "upload", ...(origin ? { origin } : {}) });
        log.info("media: upload saved");
        return res.status(201).json(audioView(meta));
      } catch (err) {
        const s = statusFor(err);
        log.info(`media: upload refused (${s.kind})`);
        return res.status(s.status).json({ error: s.kind, message: s.message });
      }
    },
  );

  const serveMedia = async (req: Request, res: Response) => {
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    const token = String(req.params.token ?? "").replace(/\.wav$/i, "");
    const p = MED_RE.test(token) ? sealer.open<MediaUrlPayload>("med", token) : undefined;
    if (!p || typeof p.authId !== "string" || typeof p.id !== "string") return res.status(404).end();
    let found: Awaited<ReturnType<MediaService["open"]>>;
    try {
      found = await service.open(p.authId, p.id);
    } catch (err) {
      log.info(`media: open failed (${err instanceof VobizError ? err.kind : "internal_error"})`);
      return res.status(503).end();
    }
    if (!found) return res.status(404).end();
    const { meta, stream } = found;
    res.status(200).set({ "Content-Type": "audio/wav", "Content-Length": String(meta.bytes), "Accept-Ranges": "none" });
    if (req.method === "HEAD") {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      return res.end();
    }
    stream.on("error", () => {
      log.info("media: stream failed");
      res.destroy();
    });
    stream.pipe(res);
  };
  router.get("/media/:token", serveMedia); // Express routes HEAD to GET handlers as well

  // Body too large, aborted uploads and other parser errors: a 4xx with a short JSON reason, never 500.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 400;
    if (status === 413) {
      return res.status(413).json({ error: "invalid_input", message: `The file is larger than ${Math.round(service.limits.maxInputBytes / 1048576)} MB.` });
    }
    return res.status(status >= 400 && status < 500 ? status : 400).json({ error: "invalid_input", message: "Bad request." });
  });

  return router;
}
