import { convert } from "@/lib/currency";
import { clampPaidAmount, roundMoney, statusAfterPayment } from "@/lib/money";
import { createId } from "@/lib/storage/utils";
import type { Course, CurrencyCode, Invoice, Payment, PayrollRun, Trainer } from "./types";

/** Kinds of records the trash bin can hold: one per deletable entity. */
export const TRASH_KINDS = ["member", "trainer", "course", "enrollment", "session", "invoice", "payment", "payrollRun"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

/** Trash kinds whose snapshots carry money: converting them on a currency switch keeps a restore from smuggling old-currency amounts back in. Members, enrollments, and sessions carry no money. */
export const MONEY_TRASH_KINDS: readonly TrashKind[] = ["course", "trainer", "invoice", "payment", "payrollRun"];

/** How long a deleted record stays in the trash before it is purged for good. */
export type TrashRetentionDays = 7 | 30;
export const TRASH_RETENTION_OPTIONS: readonly TrashRetentionDays[] = [7, 30];
export const DEFAULT_TRASH_RETENTION_DAYS: TrashRetentionDays = 7;

export const DAY_MS = 86_400_000;

/** One deleted record held in the trash, with everything needed to put it back. */
export interface TrashEntry {
  id: string;
  kind: TrashKind;
  originalId: string;
  /** Short human-readable name shown in the trash list. */
  label: string;
  /** Full copy of the deleted record, re-inserted on restore. */
  snapshot: unknown;
  /** Records deleted with it (attendance rows of a session, payments of an invoice), re-inserted on restore. */
  related: unknown[];
  /** When the record was deleted, as a millisecond timestamp. */
  deletedAt: number;
}

/** When this entry expires: the deletion time plus the retention window. */
export function trashExpiresAt(entry: TrashEntry, retentionDays: number): number {
  return entry.deletedAt + retentionDays * DAY_MS;
}

/** Whole days left before expiry, rounded up so an entry deleted today still shows the full window. Never below zero. */
export function trashDaysRemaining(entry: TrashEntry, retentionDays: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((trashExpiresAt(entry, retentionDays) - now) / DAY_MS));
}

/** Builds a trash entry for a record just removed from its live store. */
export function createTrashEntry(kind: TrashKind, originalId: string, label: string, snapshot: unknown, related: unknown[], deletedAt: number): TrashEntry {
  return { id: createId(), kind, originalId, label, snapshot, related, deletedAt };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMoney = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Converts the money amounts inside one trash entry to a new currency, so a
 * record restored after a currency switch comes back in the currency the app
 * now uses. The conversion mirrors the live one: a trashed invoice re-sums
 * its total from the converted line items, re-sums its paid amount from the
 * converted related payments, clamps dust, and re-derives its status unless
 * it is a draft; a trashed pay run re-derives its total from the converted
 * rate. Entries without money come back unchanged, and a money field that is
 * missing or not a number is left as it is, so a malformed snapshot cannot
 * fail the switch; such a snapshot is already unrestorable and the restore
 * check still refuses it.
 */
export function convertTrashEntry(entry: TrashEntry, rate: number, to: CurrencyCode): TrashEntry {
  const snapshot = entry.snapshot;
  if (!isRecord(snapshot)) return entry;
  switch (entry.kind) {
    case "course": {
      const course = snapshot as unknown as Course;
      if (!isMoney(course.price)) return entry;
      return { ...entry, snapshot: { ...course, price: convert(course.price, rate, to) } };
    }
    case "trainer": {
      const trainer = snapshot as unknown as Trainer;
      if (!isMoney(trainer.ratePerSession)) return entry;
      return { ...entry, snapshot: { ...trainer, ratePerSession: convert(trainer.ratePerSession, rate, to) } };
    }
    case "payment": {
      const payment = snapshot as unknown as Payment;
      if (!isMoney(payment.amount)) return entry;
      return { ...entry, snapshot: { ...payment, amount: convert(payment.amount, rate, to) } };
    }
    case "payrollRun": {
      const run = snapshot as unknown as PayrollRun;
      if (!isMoney(run.ratePerSession) || !isMoney(run.sessionCount)) return entry;
      const ratePerSession = convert(run.ratePerSession, rate, to);
      return { ...entry, snapshot: { ...run, ratePerSession, total: roundMoney(run.sessionCount * ratePerSession, to) } };
    }
    case "invoice": {
      const invoice = snapshot as unknown as Invoice;
      if (!Array.isArray(invoice.lineItems)) return entry;
      const lineItems = invoice.lineItems.map((item) => (isRecord(item) && isMoney(item.amount) ? { ...item, amount: convert(item.amount, rate, to) } : item));
      const total = roundMoney(
        lineItems.reduce<number>((sum, item) => sum + (isMoney(item.amount) ? item.amount : 0), 0),
        to,
      );
      const related = Array.isArray(entry.related)
        ? entry.related.map((row) => (isRecord(row) && isMoney(row.amount) ? { ...row, amount: convert(row.amount, rate, to) } : row))
        : null;
      const paidAmount =
        related === null
          ? isMoney(invoice.paidAmount)
            ? convert(invoice.paidAmount, rate, to)
            : invoice.paidAmount
          : clampPaidAmount(
              roundMoney(
                related.reduce<number>((sum, row) => sum + (isRecord(row) && isMoney(row.amount) ? row.amount : 0), 0),
                to,
              ),
              total,
              to,
            );
      const status = invoice.status === "draft" ? "draft" : statusAfterPayment(total, paidAmount, to);
      return { ...entry, snapshot: { ...invoice, lineItems, total, paidAmount, status }, related: related ?? entry.related };
    }
    default:
      return entry;
  }
}
