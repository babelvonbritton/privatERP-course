import { AppError } from "@/lib/errors/AppError";
import { createId } from "@/lib/storage/utils";
import type { StorageService } from "@/lib/storage";
import type { Clock } from "@/lib/storage/types";
import { requireCan } from "./permissions";
import { trashExpiresAt, type TrashEntry, type TrashKind, type TrashRetentionDays } from "./trash";
import type {
  Actor,
  Attendance,
  AuditLogEntry,
  Course,
  Enrollment,
  Invoice,
  InvoiceStatus,
  Member,
  Payment,
  PayrollRun,
  Session,
  Trainer,
} from "./types";

/** Paid state comes from payments only: full payment is paid, some payment is partial, no payment is sent. */
function statusAfterPayment(total: number, paidAmount: number): InvoiceStatus {
  if (paidAmount >= total) return "paid";
  if (paidAmount > 0) return "partial";
  return "sent";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The trash bin: deleted records are held here with their snapshots and
 * related rows until they expire, are restored, or are deleted for good.
 * Every restore checks its conflicts inside one transaction, so a failed
 * restore changes nothing and never overwrites or duplicates live data.
 */
export class TrashService {
  constructor(
    private readonly storage: StorageService,
    /** The actor trash audit entries are stamped with. Mutable so the shared services can follow the business profile without a rebuild. */
    private actor: Actor,
    private readonly clock: Clock = Date.now,
  ) {}

  /** Re-stamps this service with a new actor. Trash audit entries from here on use it. */
  setActor(actor: Actor): void {
    this.actor = actor;
  }

  private get db() {
    return this.storage.db;
  }

  private now(): number {
    return this.clock();
  }

  private async audit(action: string, entity: string, entityId: string, detail: string): Promise<void> {
    const entry: AuditLogEntry = {
      id: createId(),
      orgId: this.actor.orgId,
      actorId: this.actor.id,
      actorName: "Owner",
      action,
      entity,
      entityId,
      detail,
      at: this.now(),
    };
    await this.storage.audit.add(entry);
  }

  /** Newest deleted first. */
  async list(): Promise<TrashEntry[]> {
    const entries = await this.storage.trash.all();
    entries.sort((a, b) => b.deletedAt - a.deletedAt);
    return entries;
  }

  /** Days a deleted record is kept, from preferences; anything invalid repairs to the default. */
  async getRetentionDays(): Promise<TrashRetentionDays> {
    const { preferences } = await this.storage.preferences.load();
    return preferences.trashRetentionDays;
  }

  async setRetentionDays(days: TrashRetentionDays): Promise<void> {
    requireCan(this.actor, "trash.manage");
    await this.storage.preferences.set("trashRetentionDays", days);
  }

  /**
   * Puts a trashed record back, with the rows deleted alongside it. Fails
   * with RESTORE_CONFLICT when anything it needs is already taken or gone;
   * the checks and the re-insert run in one transaction, so a failed
   * restore leaves both the trash and the live stores untouched.
   */
  async restore(id: string): Promise<void> {
    requireCan(this.actor, "trash.restore");
    const d = this.db;
    await d.transaction(
      "rw",
      [d.members, d.trainers, d.courses, d.enrollments, d.sessions, d.attendance, d.invoices, d.payments, d.payrollRuns, d.trash, d.auditLog],
      async () => {
        const entry = await this.storage.trash.get(id);
        if (!entry) throw new AppError("NOT_FOUND", { details: `trash entry ${id}` });
        const snapshot = entry.snapshot;
        if (!isRecord(snapshot) || snapshot.id !== entry.originalId) {
          throw new AppError("RESTORE_CONFLICT", { details: `Trash entry for ${entry.label} has no usable snapshot` });
        }
        await this.restoreEntry(entry, snapshot);
        await this.storage.trash.remove(id);
        await this.audit(`${entry.kind}.restore`, entry.kind, entry.originalId, entry.label);
      },
    );
  }

  private async restoreEntry(entry: TrashEntry, snapshot: Record<string, unknown>): Promise<void> {
    switch (entry.kind) {
      case "member": {
        await this.noLive("member", entry.originalId);
        await this.storage.members.put(snapshot as unknown as Member);
        return;
      }
      case "trainer": {
        await this.noLive("trainer", entry.originalId);
        await this.storage.trainers.put(snapshot as unknown as Trainer);
        return;
      }
      case "course": {
        const course = snapshot as unknown as Course;
        await this.noLive("course", entry.originalId);
        // A snapshot written before v0.9.0 still carries a trainerId and a capacity: drop both, since the course no longer has either.
        const { trainerId: _droppedTrainer, capacity: _droppedCapacity, ...rest } = course as unknown as Course & { trainerId?: string; capacity?: number };
        void _droppedTrainer;
        void _droppedCapacity;
        await this.storage.courses.put({ ...rest, requiredSkills: Array.isArray(rest.requiredSkills) ? rest.requiredSkills : [] });
        return;
      }
      case "enrollment": {
        const enrollment = snapshot as unknown as Enrollment;
        await this.noLive("enrollment", entry.originalId);
        const active = await this.storage.enrollments.findActive(enrollment.memberId, enrollment.courseId);
        if (active) {
          throw new AppError("RESTORE_CONFLICT", { details: `Another active enrollment for this member and course already exists` });
        }
        const [member, course] = await Promise.all([this.storage.members.get(enrollment.memberId), this.storage.courses.get(enrollment.courseId)]);
        if (!member) throw new AppError("RESTORE_CONFLICT", { details: `Member ${enrollment.memberId} no longer exists` });
        if (!course) throw new AppError("RESTORE_CONFLICT", { details: `Course ${enrollment.courseId} no longer exists` });
        await this.storage.enrollments.put(enrollment);
        return;
      }
      case "session": {
        const session = snapshot as unknown as Session;
        await this.noLive("session", entry.originalId);
        const duplicate = await this.storage.sessions.findByCourseAndDate(session.courseId, session.date);
        if (duplicate) {
          throw new AppError("RESTORE_CONFLICT", { details: `Another session for this course on ${session.date} already exists` });
        }
        const [course, trainer] = await Promise.all([this.storage.courses.get(session.courseId), this.storage.trainers.get(session.trainerId)]);
        if (!course) throw new AppError("RESTORE_CONFLICT", { details: `Course ${session.courseId} no longer exists` });
        if (!trainer) throw new AppError("RESTORE_CONFLICT", { details: `Trainer ${session.trainerId} no longer exists` });
        const rows = this.relatedRows<Attendance>(entry);
        for (const row of rows) {
          if (!isRecord(row) || typeof row.memberId !== "string") {
            throw new AppError("RESTORE_CONFLICT", { details: `Trash entry for ${entry.label} has an attendance row without a member` });
          }
          if (!(await this.storage.members.get(row.memberId))) {
            throw new AppError("RESTORE_CONFLICT", { details: `Member ${row.memberId} in the attendance of ${entry.label} no longer exists` });
          }
        }
        await this.storage.sessions.put(session);
        for (const row of rows) await this.storage.attendance.put(row);
        return;
      }
      case "invoice": {
        const invoice = snapshot as unknown as Invoice;
        await this.noLive("invoice", entry.originalId);
        const duplicate = (await this.storage.invoices.all()).some((i) => i.number === invoice.number);
        if (duplicate) {
          throw new AppError("RESTORE_CONFLICT", { details: `Another invoice with number ${invoice.number} already exists` });
        }
        if (!(await this.storage.members.get(invoice.memberId))) {
          throw new AppError("RESTORE_CONFLICT", { details: `Member ${invoice.memberId} no longer exists` });
        }
        if (invoice.enrollmentId !== null && !(await this.storage.enrollments.get(invoice.enrollmentId))) {
          throw new AppError("RESTORE_CONFLICT", { details: `Enrollment ${invoice.enrollmentId} no longer exists` });
        }
        await this.storage.invoices.put(invoice);
        for (const payment of this.relatedRows<Payment>(entry)) await this.storage.payments.put(payment);
        return;
      }
      case "payment": {
        const payment = snapshot as unknown as Payment;
        await this.noLive("payment", entry.originalId);
        const invoice = await this.storage.invoices.get(payment.invoiceId);
        if (!invoice) throw new AppError("RESTORE_CONFLICT", { details: `Invoice ${payment.invoiceId} no longer exists` });
        if (invoice.paidAmount + payment.amount > invoice.total) {
          throw new AppError("RESTORE_CONFLICT", {
            details: `Restoring this payment would overpay invoice ${invoice.number} (${invoice.paidAmount} + ${payment.amount} is more than ${invoice.total})`,
          });
        }
        await this.storage.payments.put(payment);
        const paidAmount = invoice.paidAmount + payment.amount;
        const updated: Invoice = { ...invoice, paidAmount, status: statusAfterPayment(invoice.total, paidAmount), updatedAt: this.now(), rev: invoice.rev + 1 };
        await this.storage.invoices.put(updated);
        return;
      }
      case "payrollRun": {
        const run = snapshot as unknown as PayrollRun;
        await this.noLive("payrollRun", entry.originalId);
        const duplicate = await this.storage.payrollRuns.findByTrainerAndPeriod(run.trainerId, run.periodStart);
        if (duplicate) {
          throw new AppError("RESTORE_CONFLICT", { details: `Another pay run for this trainer starting ${run.periodStart} already exists` });
        }
        if (!(await this.storage.trainers.get(run.trainerId))) {
          throw new AppError("RESTORE_CONFLICT", { details: `Trainer ${run.trainerId} no longer exists` });
        }
        for (const sessionId of run.sessionIds) {
          if (!(await this.storage.sessions.get(sessionId))) {
            throw new AppError("RESTORE_CONFLICT", { details: `Session ${sessionId} in this pay run no longer exists` });
          }
        }
        await this.storage.payrollRuns.put(run);
        return;
      }
    }
  }

  /** Throws RESTORE_CONFLICT when a live record already uses this id. */
  private async noLive(kind: TrashKind, id: string): Promise<void> {
    const exists = await (async (): Promise<boolean> => {
      switch (kind) {
        case "member":
          return (await this.storage.members.get(id)) !== undefined;
        case "trainer":
          return (await this.storage.trainers.get(id)) !== undefined;
        case "course":
          return (await this.storage.courses.get(id)) !== undefined;
        case "enrollment":
          return (await this.storage.enrollments.get(id)) !== undefined;
        case "session":
          return (await this.storage.sessions.get(id)) !== undefined;
        case "invoice":
          return (await this.storage.invoices.get(id)) !== undefined;
        case "payment":
          return (await this.storage.payments.get(id)) !== undefined;
        case "payrollRun":
          return (await this.storage.payrollRuns.get(id)) !== undefined;
      }
    })();
    if (exists) throw new AppError("RESTORE_CONFLICT", { details: `A live ${kind} with id ${id} already exists` });
  }

  /** The rows deleted alongside the record, in the order they were stored. */
  private relatedRows<T>(entry: TrashEntry): T[] {
    if (!Array.isArray(entry.related)) return [];
    return entry.related as T[];
  }

  /** Deletes one trash entry for good. A trashed invoice also takes its attachment rows and blobs with it. */
  async deletePermanently(id: string): Promise<void> {
    requireCan(this.actor, "trash.delete");
    const d = this.db;
    await d.transaction("rw", [d.trash, d.attachments, d.attachmentBlobs, d.auditLog], async () => {
      const entry = await this.storage.trash.get(id);
      if (!entry) throw new AppError("NOT_FOUND", { details: `trash entry ${id}` });
      await this.deleteEntryFiles(entry);
      await this.storage.trash.remove(id);
      await this.audit(`${entry.kind}.delete`, entry.kind, entry.originalId, entry.label);
    });
  }

  /** Deletes every trash entry for good, with the same per-kind cleanup as a single permanent delete. */
  async empty(): Promise<void> {
    requireCan(this.actor, "trash.manage");
    const d = this.db;
    await d.transaction("rw", [d.trash, d.attachments, d.attachmentBlobs, d.auditLog], async () => {
      const entries = await this.storage.trash.all();
      for (const entry of entries) {
        await this.deleteEntryFiles(entry);
        await this.storage.trash.remove(entry.id);
        await this.audit(`${entry.kind}.delete`, entry.kind, entry.originalId, entry.label);
      }
    });
  }

  /**
   * Permanently deletes every entry past its expiry and returns how many
   * were purged. Expiry is computed from the current retention setting, so
   * changing the setting applies to entries already in the trash.
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    requireCan(this.actor, "trash.manage");
    const retentionDays = await this.getRetentionDays();
    const d = this.db;
    return d.transaction("rw", [d.trash, d.attachments, d.attachmentBlobs, d.auditLog], async () => {
      const entries = await this.storage.trash.all();
      let purged = 0;
      for (const entry of entries) {
        if (trashExpiresAt(entry, retentionDays) > now) continue;
        await this.deleteEntryFiles(entry);
        await this.storage.trash.remove(entry.id);
        await this.audit(`${entry.kind}.delete`, entry.kind, entry.originalId, entry.label);
        purged++;
      }
      return purged;
    });
  }

  /** Removes the attachment rows and blobs of a trashed invoice. Other kinds have none. */
  private async deleteEntryFiles(entry: TrashEntry): Promise<void> {
    if (entry.kind !== "invoice") return;
    const attached = await this.db.attachments.where("[entityType+entityId]").equals(["invoice", entry.originalId]).toArray();
    await this.db.attachments.where("[entityType+entityId]").equals(["invoice", entry.originalId]).delete();
    await this.db.attachmentBlobs.bulkDelete(attached.map((a) => a.id));
  }
}
