/**
 * Time zone helpers for reminder calls: validating an IANA zone, reading a wall-clock time in a zone and
 * describing a UTC instant back to the user. Built on Intl only (no date library).
 */

/** Zones offered on the consent page (a datalist: any valid IANA zone is accepted). */
export const COMMON_TIME_ZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Riyadh",
  "Asia/Karachi",
  "Asia/Dhaka",
  "Asia/Kathmandu",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "UTC",
] as const;

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

let known: Set<string> | undefined;

/**
 * True for an IANA zone Intl knows. `Intl.supportedValuesOf("timeZone")` lists canonical ICU names only
 * (Asia/Calcutta, not Asia/Kolkata; no UTC), so an alias is accepted when it resolves to a listed zone.
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(tz)) return false;
  known ??= new Set(Intl.supportedValuesOf("timeZone"));
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return known.has(tz) || known.has(resolved) || resolved === "UTC";
}

/** Offset of `tz` from UTC at instant `t`, in milliseconds (positive east of Greenwich). */
function offsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - (t - (t % 1000));
}

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a reminder time: "now", ISO 8601 with an offset (2026-10-21T06:00:00+05:30, …Z), or a wall-clock
 * ISO time without an offset (2026-10-21T06:00) read in `tz`. Returns undefined when it is not one of those.
 */
export function parseWhen(at: string, tz: string, now: number = Date.now()): Date | undefined {
  const s = at.trim();
  if (s.toLowerCase() === "now") return new Date(now);
  if (WITH_OFFSET.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  const m = LOCAL.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return undefined;
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (new Date(wall).getUTCDate() !== d) return undefined; // e.g. 31 Feb
  // Two passes settle the offset across a DST change.
  let t = wall - offsetMs(wall, tz);
  t = wall - offsetMs(t, tz);
  return new Date(t);
}

/** Short zone label for `tz`: an abbreviation such as IST, BST or EDT where one exists, else GMT+5:30 style. */
function zoneLabel(d: Date, tz: string): string {
  let fallback = "";
  for (const locale of ["en-US", "en-GB", "en-IN", "en-AU"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
    if (!fallback) fallback = name;
    if (name && !/^(GMT|UTC)[+-]/.test(name)) return name;
  }
  return fallback;
}

/** "Wed 21 Oct, 06:00 IST": how a reminder time is described to the user, in the reminder's timezone. */
export function formatLocal(iso: string | Date, tz: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")}, ${p("hour")}:${p("minute")} ${zoneLabel(d, tz)}`.trim();
}
