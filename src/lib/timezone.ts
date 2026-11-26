/**
 * The local timezone: the IANA zone the user picks in Settings. Every date
 * the app derives from a stored instant uses this zone, so a record made at
 * 02:30 local time shows that day, not the UTC day. Stored timestamps stay
 * raw millisecond instants and are never rewritten. No location detection is
 * used to pick the zone: it defaults to the device timezone and the user
 * changes it by hand.
 */

/** The device timezone, read from the platform formatter. */
export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether a value names a real IANA timezone. */
export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

let current: string = deviceTimezone();
const listeners = new Set<() => void>();

/** The zone dates are currently derived in. */
export function getTimezone(): string {
  return current;
}

/** Sets the zone dates are derived in and tells every subscriber to re-render. */
export function setTimezone(zone: string): void {
  if (!isTimezone(zone)) return;
  if (zone === current) return;
  current = zone;
  listeners.forEach((l) => l());
}

/** Subscribes to timezone changes; returns an unsubscribe function. */
export function subscribeTimezone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets listeners and resets to the device zone. Used by tests. */
export function resetTimezone(): void {
  current = deviceTimezone();
  listeners.clear();
}

/** Turns a millisecond timestamp into a YYYY-MM-DD date in the given zone. */
export function dateOf(at: number, zone: string = getTimezone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The zone's offset from UTC at an instant, in milliseconds. */
function zoneOffsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a YYYY-MM-DD day starts in the zone. */
export function dayStartMs(iso: string, zone: string = getTimezone()): number {
  const [y, m, d] = iso.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // The offset is read at the candidate instant, not at UTC midnight, so a
  // daylight-saving change at midnight lands on the right side of it.
  const first = utcMidnight - zoneOffsetMs(zone, utcMidnight);
  return utcMidnight - zoneOffsetMs(zone, first);
}

/** The last millisecond of a YYYY-MM-DD day in the zone. */
export function dayEndMs(iso: string, zone: string = getTimezone()): number {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return dayStartMs(`${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`, zone) - 1;
}

/** Every IANA zone the platform knows, in alphabetical order. "UTC" is always included: the platform list omits it, but it is a valid zone and a device can report it. */
export function timezones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? [...Intl.supportedValuesOf("timeZone")] : ["Africa/Cairo", "America/New_York", "Asia/Jakarta", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Europe/Berlin", "Europe/London", "Pacific/Auckland"];
  if (!zones.includes("UTC")) zones.push("UTC");
  return zones.sort();
}

/** A zone's UTC offset at a moment, as "UTC+07:00". */
export function zoneOffsetLabel(zone: string, at: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date(at));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!match) return "UTC+00:00";
  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = match[3] ?? "00";
  return `UTC${sign}${hours}:${minutes}`;
}

/** A zone as shown in the picker: name plus its current UTC offset. */
export function zoneLabel(zone: string): string {
  return `${zone} (${zoneOffsetLabel(zone)})`;
}
