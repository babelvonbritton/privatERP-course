import type { OlaseenaDatabase } from "./OlaseenaDatabase";
import type { BackupData } from "@/lib/domain/types";

/** Consistent whole-database reads and all-or-nothing writes, used by backup, restore and rollback. */
export class SnapshotService {
  constructor(private readonly db: OlaseenaDatabase) {}

  /** Reads every store inside one read transaction so the snapshot is internally consistent. */
  readAll(): Promise<BackupData> {
    const d = this.db;
    return d.transaction(
      "r",
      [d.members, d.trainers, d.courses, d.enrollments, d.sessions, d.attendance, d.invoices, d.payments, d.payrollRuns, d.auditLog, d.writeKeys, d.settings, d.attachments],
      async () => ({
        members: await d.members.toArray(),
        trainers: await d.trainers.toArray(),
        courses: await d.courses.toArray(),
        enrollments: await d.enrollments.toArray(),
        sessions: await d.sessions.toArray(),
        attendance: await d.attendance.toArray(),
        invoices: await d.invoices.toArray(),
        payments: await d.payments.toArray(),
        payrollRuns: await d.payrollRuns.toArray(),
        auditLog: await d.auditLog.toArray(),
        writeKeys: await d.writeKeys.toArray(),
        settings: await d.settings.toArray(),
        // File bytes stay in the separate blob store and never enter a snapshot.
        attachments: await d.attachments.toArray(),
      }),
    );
  }

  /** Replaces all data in one transaction. Any failure aborts the transaction and leaves existing data untouched. Attachment metadata is replaced here; the blob store is written by the restore step that owns the asset bytes. */
  replaceAll(data: BackupData): Promise<void> {
    const d = this.db;
    return d.transaction(
      "rw",
      [d.members, d.trainers, d.courses, d.enrollments, d.sessions, d.attendance, d.invoices, d.payments, d.payrollRuns, d.auditLog, d.writeKeys, d.settings, d.attachments],
      async () => {
        await Promise.all([
          d.members.clear(),
          d.trainers.clear(),
          d.courses.clear(),
          d.enrollments.clear(),
          d.sessions.clear(),
          d.attendance.clear(),
          d.invoices.clear(),
          d.payments.clear(),
          d.payrollRuns.clear(),
          d.auditLog.clear(),
          d.writeKeys.clear(),
          d.settings.clear(),
          d.attachments.clear(),
        ]);
        await d.members.bulkAdd(data.members);
        await d.trainers.bulkAdd(data.trainers);
        await d.courses.bulkAdd(data.courses);
        await d.enrollments.bulkAdd(data.enrollments);
        await d.sessions.bulkAdd(data.sessions);
        await d.attendance.bulkAdd(data.attendance);
        await d.invoices.bulkAdd(data.invoices);
        await d.payments.bulkAdd(data.payments);
        await d.payrollRuns.bulkAdd(data.payrollRuns);
        await d.auditLog.bulkAdd(data.auditLog);
        await d.writeKeys.bulkAdd(data.writeKeys);
        await d.settings.bulkAdd(data.settings);
        await d.attachments.bulkAdd(data.attachments ?? []);
      },
    );
  }
}
