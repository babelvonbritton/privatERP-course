import { fractionDigits, getCurrency } from "./currency";
import type { CurrencyCode } from "./domain/types";

/** Money formatted per locale in the current currency: "IDR 150,000" in English, "Rp150.000" in Indonesian. */

/** Formats an amount with no decimals for IDR and two for EUR and USD. */
export function formatMoney(amount: number, locale: string, currency: CurrencyCode = getCurrency()): string {
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/** Allocates the next invoice number for a day: INV-YYYYMMDD-###, sequential per day. */
export function nextInvoiceNumber(existing: string[], date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const prefix = `INV-${stamp}-`;
  let max = 0;
  for (const n of existing) {
    if (!n.startsWith(prefix)) continue;
    const seq = Number(n.slice(prefix.length));
    if (Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
