/**
 * Server-rendered OAuth pages: the sign-in/consent page and the plain error page. No scripts; every value escaped.
 * The layout depends on who is asking (see clients.ts):
 *   verified    "<Name> wants to use your Vobiz account." plus the redirect host in small text
 *   local       "<Name> on this computer wants ..." plus a note naming the loopback callback
 *   unverified  an amber "Unverified app" banner with the full redirect URI; Read-only is preselected
 */
import type { Config } from "../config.js";
import type { ConnectionProfile } from "../context.js";
import { BRAND_BASE_CSS, VOBIZ_LOGO_SVG, faviconLinkTag } from "../brand.js";
import { COMMON_TIME_ZONES, DEFAULT_TIME_ZONE } from "../tz.js";
import type { ClientClass } from "./clients.js";

export type Scope = ConnectionProfile["scope"];

/** What the sign-in form chose; also the form values echoed back when it is shown again with an error. */
export interface Choice {
  scope: Scope;
  callMeOn: string;
  callFrom: string;
  tz: string;
}
export const DEFAULT_CHOICE: Choice = { scope: "full", callMeOn: "", callFrom: "", tz: DEFAULT_TIME_ZONE };

export const SUPPORT_EMAIL = "support@vobiz.ai";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * CSP for the consent page: inline styles, IBM Plex Sans from Google Fonts, the favicon, no scripts. Browsers apply
 * form-action to the redirect that follows the form post, so it must allow the client's registered redirect origin as
 * well as 'self' (otherwise the 302 back to e.g. https://claude.ai/api/mcp/auth_callback is silently blocked).
 */
export function consentCsp(redirectUri: string): string {
  let origin = "";
  try {
    const u = new URL(redirectUri);
    origin = u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch {
    /* unparsable redirect: 'self' only */
  }
  return `default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self' ${origin}; frame-ancestors 'none'; base-uri 'none'`.replace(/\s+;/g, ";");
}

/** CSP for the error page: no forms at all. */
export const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const HEAD = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Vobiz MCP Server</title>
${faviconLinkTag()}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&display=swap">`;

const FOOTER = (links: Config["links"]) =>
  `<footer><a href="${esc(links.privacy)}" target="_blank" rel="noopener">Privacy policy</a> · <a href="${esc(links.docs)}" target="_blank" rel="noopener">Documentation</a></footer>`;

/** A plain page for errors that must not be redirected to the client (unverified or local clients, bad links). */
export function errorPage(o: { title: string; message: string; links: Config["links"] }): string {
  return `${HEAD(o.title)}
<style>
${BRAND_BASE_CSS}
</style></head><body>
<div class="brand">${VOBIZ_LOGO_SVG}</div>
<main>
<p class="eyebrow">Vobiz MCP Server</p>
<h1>${esc(o.title)}</h1>
<p class="err" role="alert">${esc(o.message)}</p>
<p class="fine">Go back to your app and connect again. If this keeps happening, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
</main>
${FOOTER(o.links)}
</body></html>`;
}

/** The scope a fresh consent page preselects: verified clients keep Full access, everyone else starts at Read-only. */
export function defaultChoice(client: ClientClass): Choice {
  return client.kind === "verified" ? DEFAULT_CHOICE : { ...DEFAULT_CHOICE, scope: "read" };
}

function who(client: ClientClass, redirectUri: string): string {
  const name = `<strong><bdi>${esc(client.name)}</bdi></strong>`;
  let u: URL | undefined;
  try {
    u = new URL(redirectUri);
  } catch {
    u = undefined;
  }
  const host = u?.host ?? "";
  if (client.kind === "verified") {
    return `<p class="lead">${name} wants to use your Vobiz account.</p>\n<p class="host">Returns to <bdi>${esc(host)}</bdi></p>`;
  }
  if (client.kind === "local") {
    const port = u ? u.port || (u.protocol === "https:" ? "443" : "80") : "";
    return `<p class="lead">${name} on this computer wants to use your Vobiz account.</p>
<p class="note" role="note">This app runs on your computer (callback <bdi>${esc(u?.hostname ?? "")}:${esc(port)}</bdi>). Only continue if you started it yourself.</p>`;
  }
  return `<div class="warn" role="alert"><p class="warn-title">Unverified app</p>
<p>Name: <bdi>${esc(client.name)}</bdi></p>
<p>Redirect URL: <code><bdi>${esc(redirectUri)}</bdi></code></p>
<p>Vobiz has not verified this app. Only continue if you built or trust it. Building an MCP client? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with your app name and redirect URL to get it verified.</p></div>
<p class="lead">${name} wants to use your Vobiz account.</p>`;
}

/** Sign-in page in the Vobiz brand: IBM Plex Sans, Vobiz Red #E83C00 / Orange #E86A00 / Dark Grey #100703, official lockup. */
export function consentPage(o: { txn: string; client: ClientClass; redirectUri: string; error?: string; links: Config["links"]; values?: Choice }): string {
  const v = o.values ?? defaultChoice(o.client);
  const radio = (scope: Scope, title: string, text: string) =>
    `<label class="opt" for="scope_${scope}"><input id="scope_${scope}" name="scope" type="radio" value="${scope}"${v.scope === scope ? " checked" : ""}><span><strong>${title}</strong>${text}</span></label>`;
  return `${HEAD("Connect your Vobiz account")}
<style>
${BRAND_BASE_CSS}
ul.scope{list-style:none;margin:0 0 24px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);display:grid;gap:8px}
ul.scope li{display:flex;gap:10px;align-items:flex-start;font-size:14px}
ul.scope li::before{content:"";flex:0 0 8px;height:8px;margin-top:7px;border-radius:2px 8px 2px 2px;background:var(--red)}
label{display:block;font-weight:500;font-size:14px;margin:16px 0 6px}
input[type=text],input[type=password]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);background:var(--input);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=text]::placeholder{color:var(--muted);font-weight:300}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--ring)}
fieldset{border:0;margin:20px 0 0;padding:0;display:grid;gap:8px}
legend{font-weight:500;font-size:14px;padding:0;margin:0 0 8px}
.opt{display:flex;gap:10px;align-items:flex-start;margin:0;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);font-weight:400;font-size:14px;color:var(--muted);cursor:pointer;transition:border-color .15s}
.opt input{accent-color:var(--red);width:16px;height:16px;margin:3px 0 0;flex:0 0 auto}
.opt strong{display:block;color:var(--fg);font-weight:500}
.opt:has(input:checked){border-color:var(--red)}
.opt:has(input:focus-visible){box-shadow:0 0 0 3px var(--ring)}
.profile{margin-top:4px}
form:has(#scope_read:checked) .profile{display:none}
.hint{display:block;font-weight:300;font-size:13px;color:var(--muted);margin:4px 0 0}
input[type=tel]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius);background:var(--input);color:var(--fg);font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=tel]::placeholder{color:var(--muted);font-weight:300}
input[type=tel]:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--ring)}
.lead{margin-bottom:6px}
.host{font-size:13px;font-weight:300;color:var(--muted);margin:0 0 22px;overflow-wrap:anywhere}
.note{font-size:13px;color:var(--fg);margin:0 0 22px;padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--orange);border-radius:var(--radius)}
.warn{margin:0 0 18px;padding:12px 14px;border-radius:var(--radius);border:1px solid #d97706;background:color-mix(in srgb,#f59e0b 14%,transparent);color:var(--fg);font-size:13px}
.warn p{margin:6px 0 0;overflow-wrap:anywhere}
.warn .warn-title{margin:0;font-weight:600;font-size:15px;color:#b45309}
@media (prefers-color-scheme:dark){.warn .warn-title{color:#fbbf24}}
.warn code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head><body>
<div class="brand">${VOBIZ_LOGO_SVG}</div>
<main>
<p class="eyebrow">Vobiz MCP Server</p>
<h1>Connect your Vobiz account</h1>
${who(o.client, o.redirectUri)}
<ul class="scope">
<li>Read your calls, call records, numbers, SIP trunks, messages and balance</li>
<li>Place calls, send messages or change settings only after you confirm each one</li>
<li>Schedule reminder and wake-up calls that Vobiz places at the time you ask, with your own audio if you add some</li>
</ul>
<form method="post" action="/oauth/login" autocomplete="off">
<input type="hidden" name="txn" value="${esc(o.txn)}">
<label for="auth_id">Auth ID</label><input id="auth_id" name="auth_id" type="text" placeholder="MA_XXXXXXXX" required pattern="(MA|SA)_[A-Za-z0-9]+" spellcheck="false" autocapitalize="off">
<label for="auth_token">Auth Token</label><input id="auth_token" name="auth_token" type="password" required>
<fieldset><legend>Access</legend>
${radio("full", "Full access", "Every tool. Calls, messages and account changes only after you confirm each one.")}
${radio("assistant", "Personal assistant", "Only reminder and wake-up calls to your own number, plus your balance, numbers and call status.")}
${radio("read", "Read-only", "No calls, messages, reminders or account changes.")}
</fieldset>
<div class="profile">
<label for="call_me_on">Call me on <span class="hint">Your own number in E.164, e.g. +919876543210. Reminder calls go here. Required for personal assistant.</span></label><input id="call_me_on" name="call_me_on" type="tel" placeholder="+919876543210" value="${esc(v.callMeOn)}" pattern="\\+?[0-9]{7,15}" inputmode="tel" autocomplete="tel">
<label for="call_from">Call from <span class="hint">Optional: a voice number on your Vobiz account. Blank = your first voice number.</span></label><input id="call_from" name="call_from" type="tel" placeholder="+918012345678" value="${esc(v.callFrom)}" pattern="\\+?[0-9]{7,15}" inputmode="tel">
<label for="timezone">Timezone <span class="hint">Used to read and say reminder times.</span></label><input id="timezone" name="timezone" type="text" list="tz_list" value="${esc(v.tz)}" spellcheck="false" autocapitalize="off">
<datalist id="tz_list">${COMMON_TIME_ZONES.map((z) => `<option value="${esc(z)}"></option>`).join("")}</datalist>
</div>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<button type="submit">Allow access</button>
</form>
<p class="fine">Your Auth ID and Auth Token are on the <a href="${esc(o.links.console)}" target="_blank" rel="noopener">Vobiz console</a> overview page. They are encrypted inside the access token issued to this app and never stored by Vobiz MCP Server. Rotate your Auth Token in the console at any time to revoke access.</p>
</main>
${FOOTER(o.links)}
</body></html>`;
}
