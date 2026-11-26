import { fractionDigits, getCurrency } from "./currency";
import type { CurrencyCode, InvoiceStatus } from "./domain/types";

/** Money formatted per locale in the current currency: "IDR 150,000" in English, "Rp150.000" in Indonesian. */

/** Formats an amount with no decimals for IDR and two for EUR and USD. */
export function formatMoney(amount: number, locale: string, currency: CurrencyCode = getCurrency()): string {
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/**
 * Rounds an amount to the currency's precision, the way the converter does.
 * Every money total written to storage goes through this, so 1.10 + 2.20
 * stores 3.30 and never 3.3000000000000003.
 */
export function roundMoney(amount: number, currency: CurrencyCode = getCurrency()): number {
  const digits = fractionDigits(currency);
  const factor = 10 ** digits;
  return Math.round(amount * factor) / factor;
}

/** Whether two amounts are equal once rounded to the currency's precision. */
export function moneyEquals(a: number, b: number, currency: CurrencyCode = getCurrency()): boolean {
  return roundMoney(a, currency) === roundMoney(b, currency);
}

/** One minor unit of the currency: 1 rupiah, 1 cent. */
function minorUnit(currency: CurrencyCode): number {
  return 10 ** -fractionDigits(currency);
}

/**
 * Clamps a paid amount to its total when the overage is rounding dust (at
 * most one minor unit). A larger overage passes through unchanged, so a real
 * overpayment is still caught by the caller's check.
 */
export function clampPaidAmount(paidAmount: number, total: number, currency: CurrencyCode = getCurrency()): number {
  if (paidAmount > total && roundMoney(paidAmount - total, currency) <= minorUnit(currency)) return total;
  return paidAmount;
}

/** Paid state comes from payments only: full payment is paid, some payment is partial, no payment is sent. */
export function statusAfterPayment(total: number, paidAmount: number, currency: CurrencyCode = getCurrency()): InvoiceStatus {
  if (roundMoney(paidAmount, currency) >= roundMoney(total, currency)) return "paid";
  if (roundMoney(paidAmount, currency) > 0) return "partial";
  return "sent";
}

/** Allocates the next invoice number for a day: INV-YYYYMMDD-###, sequential per day. `dayStamp` is the day in YYYYMMDD form, already derived in the chosen timezone. */
export function nextInvoiceNumber(existing: string[], dayStamp: string): string {
  const prefix = `INV-${dayStamp}-`;
  let max = 0;
  for (const n of existing) {
    if (!n.startsWith(prefix)) continue;
    const seq = Number(n.slice(prefix.length));
    if (Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
