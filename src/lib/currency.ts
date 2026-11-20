import { AppError } from "@/lib/errors/AppError";
import { CURRENCIES, isCurrencyCode, type CurrencyCode, type SettingRecord } from "@/lib/domain/types";

/** How many currency switches are allowed per local day. */
export const DAILY_SWITCH_LIMIT = 10;
/** How long a rate request may take before it is abandoned. */
export const RATE_TIMEOUT_MS = 10_000;

const FRANKFURTER = "https://api.frankfurter.dev/v1/latest";
const FALLBACK = "https://api.exchangerate-api.com/v4/latest";

/** Fraction digits shown for a currency: whole rupiah, two decimals otherwise. */
export function fractionDigits(currency: CurrencyCode): number {
  return currency === "IDR" ? 0 : 2;
}

/** Converts an amount at a rate, rounding to the target currency's precision. */
export function convert(amount: number, rate: number, to: CurrencyCode): number {
  const digits = fractionDigits(to);
  const factor = 10 ** digits;
  return Math.round(amount * rate * factor) / factor;
}

/** Local date as YYYY-MM-DD, used to count switches per day. */
export function localDateString(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type FetchFn = typeof fetch;

interface FrankfurterResponse {
  base?: unknown;
  rates?: unknown;
}

function parseRate(body: unknown, to: CurrencyCode): number | null {
  if (typeof body !== "object" || body === null) return null;
  const rates = (body as FrankfurterResponse).rates;
  if (typeof rates !== "object" || rates === null) return null;
  const value = (rates as Record<string, unknown>)[to];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchOnce(url: string, to: CurrencyCode, fetchFn: FetchFn): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    if (!response.ok) return null;
    return parseRate(await response.json(), to);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the rate to convert one unit of `from` into `to`. Tries the free ECB
 * reference rates first, then a second free source; returns 1 for a same-currency
 * request without touching the network. Throws CURRENCY_FETCH_FAILED when no
 * source returns a usable rate.
 */
export async function fetchRate(from: CurrencyCode, to: CurrencyCode, fetchFn: FetchFn = fetch): Promise<number> {
  if (from === to) return 1;
  const primary = await fetchOnce(`${FRANKFURTER}?base=${from}&symbols=${to}`, to, fetchFn);
  if (primary !== null) return primary;
  const fallback = await fetchOnce(`${FALLBACK}/${from}`, to, fetchFn);
  if (fallback !== null) return fallback;
  throw new AppError("CURRENCY_FETCH_FAILED", { details: `no usable rate for ${from} to ${to}` });
}

/** Reads the stored currency out of a settings list, defaulting to IDR when absent or invalid. */
export function currencyFromSettings(settings: SettingRecord[]): CurrencyCode {
  const row = settings.find((s) => s.key === "pref.currency");
  return row && isCurrencyCode(row.value) ? row.value : "IDR";
}

// ------------------------------------------------------------ current currency

let current: CurrencyCode = "IDR";
const listeners = new Set<() => void>();

/** The currency amounts are currently stored and shown in. */
export function getCurrency(): CurrencyCode {
  return current;
}

/** Sets the current currency and tells every subscriber to re-render. */
export function setCurrency(currency: CurrencyCode): void {
  if (!CURRENCIES.includes(currency)) return;
  if (currency === current) return;
  current = currency;
  listeners.forEach((l) => l());
}

/** Subscribes to currency changes; returns an unsubscribe function. */
export function subscribeCurrency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets listeners and resets to IDR. Used by tests. */
export function resetCurrency(): void {
  current = "IDR";
  listeners.clear();
}
