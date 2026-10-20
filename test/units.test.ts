import { loadConfig } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VobizError } from "../src/errors.js";
import { IdempotencyStore, withIdempotency } from "../src/idempotency.js";
import { classifyHangup } from "../src/outcomes.js";
import { assertDestinationAllowed, effectiveTimeLimit } from "../src/policy.js";
import { assertAllowedUrl, fail, redact } from "../src/util.js";
import { EventStore, baseUrlFor, signV2, signV3, verifySignature } from "../src/webhooks.js";
import { buildResponseXml, type XmlAction } from "../src/xml.js";
import { testConfig } from "./helpers.js";

const kind = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof VobizError ? e.kind : "other";
  }
  return "none";
};

describe("call policy", () => {
  it("ships with no country restriction and no hard-coded currency", () => {
    const shipped = loadConfig({});
    expect(shipped.policy.allowedCountryCodes).toEqual([]);
    expect(shipped.policy.balanceCurrency).toBe("");
    expect(shipped.enableCalls || shipped.enableMessaging || shipped.enableProvisioning).toBe(false);
    expect(loadConfig({ VOBIZ_PRIVACY_URL: "https://example.com/p" }).links.privacy).toBe("https://example.com/p");
    expect(() => loadConfig({ VOBIZ_DOCS_URL: "http://insecure" })).toThrow(/https/);
  });

  it("allows only configured destination countries", () => {
    const cfg = testConfig();
    expect(kind(() => assertDestinationAllowed(cfg, "+919812345678"))).toBe("none");
    expect(kind(() => assertDestinationAllowed(cfg, "+14155550123"))).toBe("not_allowed");
    const all = testConfig({ VOBIZ_ALLOWED_COUNTRY_CODES: "" });
    expect(kind(() => assertDestinationAllowed(all, "+14155550123"))).toBe("none");
    const multi = testConfig({ VOBIZ_ALLOWED_COUNTRY_CODES: "+91, 1" });
    expect(kind(() => assertDestinationAllowed(multi, "+14155550123"))).toBe("none");
  });

  it("blocks configured prefixes even inside allowed countries", () => {
    const cfg = testConfig({ VOBIZ_BLOCKED_PREFIXES: "91900,+91140" });
    expect(kind(() => assertDestinationAllowed(cfg, "+919001234567"))).toBe("not_allowed");
    expect(kind(() => assertDestinationAllowed(cfg, "+911401234567"))).toBe("not_allowed");
    expect(kind(() => assertDestinationAllowed(cfg, "+919812345678"))).toBe("none");
  });

  it("caps call duration server-side", () => {
    const cfg = testConfig({ VOBIZ_MAX_CALL_DURATION_SEC: "300" });
    expect(effectiveTimeLimit(cfg)).toBe(300);
    expect(effectiveTimeLimit(cfg, 120)).toBe(120);
    expect(kind(() => effectiveTimeLimit(cfg, 301))).toBe("not_allowed");
  });

  it("rejects bad policy configuration at startup", () => {
    expect(() => testConfig({ VOBIZ_ALLOWED_COUNTRY_CODES: "India" })).toThrow(/VOBIZ_ALLOWED_COUNTRY_CODES/);
    expect(() => testConfig({ VOBIZ_MAX_CALL_DURATION_SEC: "0" })).toThrow(/VOBIZ_MAX_CALL_DURATION_SEC/);
    expect(() => testConfig({ VOBIZ_WEBHOOK_SIGNATURE: "maybe" })).toThrow(/VOBIZ_WEBHOOK_SIGNATURE/);
    expect(() => testConfig({ VOBIZ_PUBLIC_URL: "http://ops.example.com" })).toThrow(/https/);
    expect(() => testConfig({ VOBIZ_ENV: "production", VOBIZ_BASE_URL: "http://localhost:9" })).toThrow(/production/);
  });

  it("approves call-control URLs only on allowed hosts", () => {
    const cfg = testConfig({ VOBIZ_PUBLIC_URL: "https://ops.example.net", VOBIZ_ALLOWED_URL_HOSTS: "flows.example.org" });
    for (const ok of ["https://ops.example.net/x", "https://example.com/answer.xml", "https://flows.example.org/a"]) {
      expect(kind(() => assertAllowedUrl(cfg, ok, "u"))).toBe("none");
    }
    expect(kind(() => assertAllowedUrl(cfg, "https://evil.example/x", "u"))).toBe("not_allowed");
    expect(kind(() => assertAllowedUrl(cfg, "http://ops.example.net/x", "u"))).toBe("invalid_input");
    expect(kind(() => assertAllowedUrl(cfg, "https://user:pw@ops.example.net/x", "u"))).toBe("invalid_input");
    expect(kind(() => assertAllowedUrl(cfg, "not a url", "u"))).toBe("invalid_input");
  });
});

describe("idempotency", () => {
  const fp = IdempotencyStore.fingerprint({ a: 1 });

  it("replays a finished result instead of running again", async () => {
    const s = new IdempotencyStore();
    let runs = 0;
    const op = async () => ({ ok: true, n: ++runs });
    expect(await withIdempotency(s, "k1", fp, op)).toEqual({ ok: true, n: 1 });
    expect(await withIdempotency(s, "k1", fp, op)).toEqual({ ok: true, n: 1, replayed: true });
    expect(runs).toBe(1);
  });

  it("rejects the same key with different parameters", async () => {
    const s = new IdempotencyStore();
    await withIdempotency(s, "k1", fp, async () => ({ ok: true }));
    await expect(withIdempotency(s, "k1", IdempotencyStore.fingerprint({ a: 2 }), async () => ({}))).rejects.toMatchObject({ kind: "idempotency_conflict" });
  });

  it("lets only one of two concurrent identical requests run", async () => {
    const s = new IdempotencyStore();
    let runs = 0;
    const slow = () => new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ n: ++runs }), 20));
    const results = await Promise.allSettled([withIdempotency(s, "k", fp, slow), withIdempotency(s, "k", fp, slow)]);
    expect(runs).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.kind).toBe("in_progress");
  });

  it("keeps an unknown outcome blocked and releases a definitive failure", async () => {
    const s = new IdempotencyStore();
    await expect(withIdempotency(s, "u", fp, async () => { throw new VobizError("outcome_unknown", "x"); })).rejects.toBeTruthy();
    await expect(withIdempotency(s, "u", fp, async () => ({ ok: true }))).rejects.toMatchObject({ kind: "outcome_unknown" });
    await expect(withIdempotency(s, "f", fp, async () => { throw new VobizError("insufficient_balance", "x"); })).rejects.toBeTruthy();
    expect(await withIdempotency(s, "f", fp, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("persists to a file and treats in-flight records as unknown after a restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idem-"));
    const file = path.join(dir, "store.json");
    try {
      const a = new IdempotencyStore(3600_000, file);
      await withIdempotency(a, "done", fp, async () => ({ ok: true, id: "r1" }));
      a.begin("crash", fp); // simulate process dying mid-request
      a.succeed("noop", {});
      // force a save of the in-flight record
      (a as unknown as { save(): void }).save();
      const b = new IdempotencyStore(3600_000, file);
      expect(b.begin("done", fp)).toMatchObject({ id: "r1", replayed: true });
      expect(() => b.begin("crash", fp)).toThrow(/unknown outcome/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expires automatic duplicate records after the window", () => {
    let now = 0;
    const s = new IdempotencyStore(3600_000, undefined, () => now);
    s.begin("auto", fp);
    s.succeed("auto", { ok: true });
    now = 10_000;
    s.dropIfOlder("auto", 120_000);
    expect(s.begin("auto", fp)).toMatchObject({ replayed: true });
    now = 200_000;
    s.dropIfOlder("auto", 120_000);
    expect(s.begin("auto", fp)).toBeUndefined();
  });
});

describe("hangup outcome classification", () => {
  it.each([
    ["USER_BUSY", 40, "busy", 486, true],
    ["NO_ANSWER", 0, "no_answer", 480, true],
    ["CALL_REJECTED", 0, "rejected", 603, false],
    ["UNALLOCATED_NUMBER", 0, "invalid_number", 404, false],
    ["NORMAL_TEMPORARY_FAILURE", 0, "network_failure", 503, true],
    ["ORIGINATOR_CANCEL", 0, "cancelled", 487, false],
    ["NORMAL_CLEARING", 42, "answered", null, false],
  ])("%s → %s", (cause, billsec, outcome, sip, retry) => {
    expect(classifyHangup(cause, billsec)).toEqual({ outcome, typical_sip_code: sip, retryable: retry });
  });
  it("treats an unanswered NORMAL_CLEARING as no answer and unknown causes as failed", () => {
    expect(classifyHangup("NORMAL_CLEARING", 0).outcome).toBe("no_answer");
    expect(classifyHangup("SOMETHING_NEW").outcome).toBe("failed");
    expect(classifyHangup(undefined).outcome).toBe("unknown");
  });
});

describe("XML builder", () => {
  const cfg = testConfig({ VOBIZ_PUBLIC_URL: "https://ops.example.net" });
  const o = { checkUrl: (u: string, f: string) => assertAllowedUrl(cfg, u, f), checkDestination: (n: string) => assertDestinationAllowed(cfg, n) };

  it("builds documented verbs with escaping", () => {
    const xml = buildResponseXml(
      [
        { type: "speak", text: `Tom & Jerry <say> "hi"`, voice: "MAN", language: "en-IN", loop: 2 },
        { type: "play", url: "https://cdn.example.org/a.mp3?x=1&y=2" },
        { type: "wait", length: 2 },
        { type: "hangup" },
      ],
      o,
    );
    expect(xml).toContain(`<Speak voice="MAN" language="en-IN" loop="2">Tom &amp; Jerry &lt;say&gt; &quot;hi&quot;</Speak>`);
    expect(xml).toContain(`<Play>https://cdn.example.org/a.mp3?x=1&amp;y=2</Play>`);
    expect(xml).toContain(`<Wait length="2"/>`);
    expect(xml.trim().startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
    expect(xml).toMatch(/<Response>[\s\S]*<\/Response>/);
  });

  it("nests prompts in Gather with documented attribute names", () => {
    const xml = buildResponseXml(
      [{ type: "gather", action_url: "https://ops.example.net/g", num_digits: 4, execution_timeout: 10, finish_on_key: "#", prompt: [{ type: "speak", text: "Enter PIN" }] }],
      o,
    );
    expect(xml).toContain(`<Gather action="https://ops.example.net/g" method="POST" inputType="dtmf" numDigits="4" executionTimeout="10" finishOnKey="#">`);
    expect(xml).toContain(`<Speak>Enter PIN</Speak>`);
    expect(xml).not.toContain(` timeout=`);
  });

  it("always emits Record redirect explicitly (the live core defaults it to true)", () => {
    const xml = buildResponseXml([{ type: "record", action_url: "https://ops.example.net/r", max_length: 30 }], o);
    expect(xml).toContain(`redirect="false"`);
  });

  it("builds Dial for numbers and SIP users", () => {
    expect(buildResponseXml([{ type: "dial", number: "919812345678", caller_id: "+919000000001" }], o)).toContain("<Number>+919812345678</Number>");
    expect(buildResponseXml([{ type: "dial", sip_uri: "sip:alice@example.com" }], o)).toContain("<User>sip:alice@example.com</User>");
    expect(kind(() => buildResponseXml([{ type: "dial" } as XmlAction], o))).toBe("invalid_input");
  });

  it.each([
    ["action after hangup", [{ type: "hangup" }, { type: "speak", text: "x" }], "invalid_input"],
    ["action after redirect", [{ type: "redirect", url: "https://ops.example.net/n" }, { type: "hangup" }], "invalid_input"],
    ["redirect to unapproved host", [{ type: "redirect", url: "https://evil.example/n" }], "not_allowed"],
    ["gather action to unapproved host", [{ type: "gather", action_url: "https://evil.example/g" }], "not_allowed"],
    ["non-audio play URL", [{ type: "play", url: "https://cdn.example.org/a.exe" }], "invalid_input"],
    ["http play URL", [{ type: "play", url: "http://cdn.example.org/a.mp3" }], "invalid_input"],
    ["unknown verb", [{ type: "say", text: "x" }], "invalid_input"],
    ["empty", [], "invalid_input"],
    ["gather without any action URL", [{ type: "gather" }], "invalid_input"],
  ])("rejects %s", (_l, actions, k) => {
    expect(kind(() => buildResponseXml(actions as XmlAction[], o))).toBe(k);
  });

  it("allows a scheduled hangup followed by more actions", () => {
    expect(() => buildResponseXml([{ type: "hangup", schedule: 30 }, { type: "speak", text: "bye" }], o)).not.toThrow();
  });
});

describe("webhook signatures", () => {
  const token = "test-token-not-real";
  const base = "https://ops.example.net/webhooks/vobiz";

  it("accepts valid V3 and V2 signatures and rejects tampering", () => {
    const n = "12345678901234567890";
    expect(verifySignature({ "x-vobiz-signature-v3": signV3(token, base, n), "x-vobiz-signature-v3-nonce": n }, base, token)).toMatchObject({ valid: true, version: "v3" });
    expect(verifySignature({ "x-vobiz-signature-v2": signV2(token, base, n), "x-vobiz-signature-v2-nonce": n }, base, token)).toMatchObject({ valid: true, version: "v2" });
    expect(verifySignature({ "x-vobiz-signature-v3": signV3("other", base, n), "x-vobiz-signature-v3-nonce": n }, base, token)).toMatchObject({ valid: false, present: true });
    expect(verifySignature({ "x-vobiz-signature-v3": signV3(token, base + "x", n), "x-vobiz-signature-v3-nonce": n }, base, token).valid).toBe(false);
    expect(verifySignature({}, base, token)).toMatchObject({ valid: false, present: false });
  });

  it("matches the documented algorithm: base64(HMAC-SHA256(token, url + '.' + nonce))", async () => {
    const { createHmac } = await import("node:crypto");
    expect(signV3(token, base, "1")).toBe(createHmac("sha256", token).update(base + ".1").digest("base64"));
  });

  it("signs the URL without its query string", () => {
    expect(baseUrlFor("https://ops.example.net", "/webhooks/vobiz?x=1")).toBe(base);
  });

  it("deduplicates identical events and detects reused nonces", () => {
    const s = new EventStore();
    expect(s.add({ Event: "Hangup", CallUUID: "c1" }, true).duplicate).toBe(false);
    expect(s.add({ CallUUID: "c1", Event: "Hangup" }, true).duplicate).toBe(true);
    expect(s.add({ Event: "Hangup", CallUUID: "c2" }, true).duplicate).toBe(false);
    expect(s.nonceReused("n1")).toBe(false);
    expect(s.nonceReused("n1")).toBe(true);
    expect(s.list({ call_uuid: "c1" })).toHaveLength(1);
  });
});

describe("errors and redaction", () => {
  it("marks retryable errors and never leaks unknown exceptions", () => {
    expect(fail(new VobizError("rate_limited", "slow")).structuredContent).toMatchObject({ error: "rate_limited", retryable: true });
    expect(fail(new VobizError("insufficient_balance", "x")).structuredContent).toMatchObject({ retryable: false });
    const r = fail(new Error("db password=hunter2 at line 3"));
    expect(r.structuredContent).toMatchObject({ error: "internal_error" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("redacts nested secrets", () => {
    expect(redact({ a: { auth_token: "x", list: [{ password: "p", name: "n" }] } })).toEqual({ a: { auth_token: "[redacted]", list: [{ password: "[redacted]", name: "n" }] } });
  });
});

describe("client placeholders", () => {
  it("treats unexpanded ${VAR} placeholders from MCP clients as unset", () => {
    const cfg = loadConfig({ VOBIZ_AUTH_ID: "${user_config.auth_id}", VOBIZ_AUTH_TOKEN: "$VOBIZ_AUTH_TOKEN", VOBIZ_ENABLE_CALLS: "${user_config.enable_calls}" });
    expect(cfg.authId).toBeUndefined();
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.enableCalls).toBe(false);
  });
});

describe("reminder-call configuration", () => {
  it("defaults to enabled with the in-memory backend and brief limits", () => {
    const c = loadConfig({});
    expect(c.reminders).toEqual({
      enabled: true,
      gcpProject: undefined,
      tasksLocation: undefined,
      tasksQueue: undefined,
      firestoreDatabase: "(default)",
      firestoreCollection: "reminders",
      maxActive: 20,
      maxCallsPerDay: 10,
    });
    expect(c.openaiAppsChallenge).toBeUndefined();
  });

  it("parses the Cloud Tasks backend, limits and the OpenAI challenge", () => {
    const c = loadConfig({
      VOBIZ_REMINDERS: "false",
      VOBIZ_GCP_PROJECT: "integrations-510010",
      VOBIZ_TASKS_LOCATION: "asia-south1",
      VOBIZ_TASKS_QUEUE: "vobiz-reminders",
      VOBIZ_FIRESTORE_DATABASE: "mcp-db",
      VOBIZ_FIRESTORE_COLLECTION: "reminders_prod",
      VOBIZ_MAX_ACTIVE_REMINDERS: "5",
      VOBIZ_MAX_REMINDER_CALLS_PER_DAY: "3",
      VOBIZ_OPENAI_APPS_CHALLENGE: "abc123",
    });
    expect(c.reminders).toMatchObject({ enabled: false, gcpProject: "integrations-510010", tasksLocation: "asia-south1", tasksQueue: "vobiz-reminders", firestoreDatabase: "mcp-db", firestoreCollection: "reminders_prod", maxActive: 5, maxCallsPerDay: 3 });
    expect(c.openaiAppsChallenge).toBe("abc123");
  });

  it("rejects a partial or malformed backend config", () => {
    expect(() => loadConfig({ VOBIZ_GCP_PROJECT: "integrations-510010" })).toThrow(/all of VOBIZ_GCP_PROJECT/);
    expect(() => loadConfig({ VOBIZ_TASKS_LOCATION: "Asia South" })).toThrow(/VOBIZ_TASKS_LOCATION/);
    expect(() => loadConfig({ VOBIZ_FIRESTORE_COLLECTION: "a/b" })).toThrow(/VOBIZ_FIRESTORE_COLLECTION/);
    expect(() => loadConfig({ VOBIZ_MAX_ACTIVE_REMINDERS: "0" })).toThrow(/VOBIZ_MAX_ACTIVE_REMINDERS/);
  });
});

describe("audio library configuration", () => {
  it("defaults to local disk with the brief limits", () => {
    expect(loadConfig({}).media).toEqual({ bucket: undefined, dir: undefined, maxInputMb: 15, maxDurationSec: 300, maxPerAccount: 50, maxUploadsPerDay: 20 });
  });

  it("parses the bucket, directory and limits", () => {
    const c = loadConfig({
      VOBIZ_MEDIA_BUCKET: "vobiz-mcp-media",
      VOBIZ_MEDIA_DIR: "/var/lib/vobiz-media",
      VOBIZ_MEDIA_MAX_INPUT_MB: "8",
      VOBIZ_MEDIA_MAX_DURATION_SEC: "120",
      VOBIZ_MEDIA_MAX_PER_ACCOUNT: "10",
      VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY: "5",
    });
    expect(c.media).toEqual({ bucket: "vobiz-mcp-media", dir: "/var/lib/vobiz-media", maxInputMb: 8, maxDurationSec: 120, maxPerAccount: 10, maxUploadsPerDay: 5 });
  });

  it("rejects malformed values", () => {
    expect(() => loadConfig({ VOBIZ_MEDIA_BUCKET: "gs://My Bucket" })).toThrow(/VOBIZ_MEDIA_BUCKET/);
    expect(() => loadConfig({ VOBIZ_MEDIA_MAX_INPUT_MB: "0" })).toThrow(/VOBIZ_MEDIA_MAX_INPUT_MB/);
    expect(() => loadConfig({ VOBIZ_MEDIA_MAX_INPUT_MB: "2.5" })).toThrow(/VOBIZ_MEDIA_MAX_INPUT_MB/);
    expect(() => loadConfig({ VOBIZ_MEDIA_MAX_DURATION_SEC: "99999" })).toThrow(/VOBIZ_MEDIA_MAX_DURATION_SEC/);
    expect(() => loadConfig({ VOBIZ_MEDIA_MAX_PER_ACCOUNT: "-1" })).toThrow(/VOBIZ_MEDIA_MAX_PER_ACCOUNT/);
    expect(() => loadConfig({ VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY: "many" })).toThrow(/VOBIZ_MEDIA_MAX_UPLOADS_PER_DAY/);
  });
});
