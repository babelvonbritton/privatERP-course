import { isRealDate } from "@/lib/storage/utils";

/** Dates are stored as YYYY-MM-DD strings so they sort, compare and index as plain text. */

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

/** Today as YYYY-MM-DD in local time. */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The first and last day of the month containing the given YYYY-MM-DD date. */
export function monthRange(iso: string): { start: string; end: string } {
  const d = parseDate(iso);
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start, end: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` };
}
