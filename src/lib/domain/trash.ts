import { createId } from "@/lib/storage/utils";

/** Kinds of records the trash bin can hold: one per deletable entity. */
export const TRASH_KINDS = ["member", "trainer", "course", "enrollment", "session", "invoice", "payment", "payrollRun"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

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
