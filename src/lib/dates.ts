import { isRealDate } from "@/lib/storage/utils";
import { dateOf, getTimezone } from "@/lib/timezone";

export { dateOf } from "@/lib/timezone";

const pad = (n: number) => String(n).padStart(2, "0");

/** Parses a YYYY-MM-DD string into a local date. Throws on anything else. */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!iso || !isRealDate(iso)) throw new Error(`Not a date: ${iso}`);
  return new Date(y, m - 1, d);
}

/** Formats a YYYY-MM-DD string in the active language (medium date style). */
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parseDate(iso));
}

/** Today as YYYY-MM-DD in the chosen timezone. */
export function todayIso(now = new Date()): string {
  return dateOf(now.getTime(), getTimezone());
}

/** The first and last day of the month containing the given YYYY-MM-DD date. */
export function monthRange(iso: string): { start: string; end: string } {
  const d = parseDate(iso);
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start, end: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` };
}
