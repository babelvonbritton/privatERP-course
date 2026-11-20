import { PAYMENT_METHODS, type Invoice, type PaymentMethod } from "@/lib/domain/types";

/**
 * Normalizes a payment method read from a stored record. Rows written before
 * the payment fields existed carry no method, so an unknown or missing value
 * reads as cash, the same default new invoices get at creation.
 */
export function paymentMethodValue(value: unknown): PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value as string) ? (value as PaymentMethod) : "cash";
}

/**
 * Reads the payment method of an invoice, defaulting a legacy row without the
 * field to cash. Use this everywhere a method label is built from an invoice
 * so no lookup is ever built from an undefined value.
 */
export function paymentMethodOf(invoice: Pick<Invoice, "paymentMethod"> | { paymentMethod?: PaymentMethod | string | null } | null | undefined): PaymentMethod {
  return paymentMethodValue(invoice?.paymentMethod);
}

/** Reads the payment details of an invoice, defaulting a legacy row to empty. */
export function paymentDetailsOf(invoice: Pick<Invoice, "paymentDetails"> | { paymentDetails?: string | null } | null | undefined): string {
  return typeof invoice?.paymentDetails === "string" ? invoice.paymentDetails : "";
}
