import Dexie, { type Table } from "dexie";
import type { Attachment } from "@/lib/domain/attachments";
import type { TrashEntry } from "@/lib/domain/trash";
import type {
  Attendance,
  AuditLogEntry,
  Course,
  Enrollment,
  Invoice,
  Member,
  Payment,
  PayrollRun,
  Session,
  SettingRecord,
  Trainer,
  WriteKey,
} from "@/lib/domain/types";

/**
 * IndexedDB schema with one store per entity.
 * Every store indexes the fields its search bar queries (name, email, phone, title, number, status, dates),
 * so search reads through indexes and never scans the whole store.
 */
export class OlaseenaDatabase extends Dexie {
  members!: Table<Member, string>;
  trainers!: Table<Trainer, string>;
  courses!: Table<Course, string>;
  enrollments!: Table<Enrollment, string>;
  sessions!: Table<Session, string>;
  attendance!: Table<Attendance, string>;
  invoices!: Table<Invoice, string>;
  payments!: Table<Payment, string>;
  payrollRuns!: Table<PayrollRun, string>;
  auditLog!: Table<AuditLogEntry, string>;
  writeKeys!: Table<WriteKey, string>;
  settings!: Table<SettingRecord, string>;
  attachments!: Table<Attachment, string>;
  /** Deleted records held for restore, keyed by trash entry id. */
  trash!: Table<TrashEntry, string>;
  /** File bytes, kept apart from the metadata so snapshots never inline blobs into JSON. Bytes are stored as a typed array, which structured clone preserves in every runtime, and turned back into a Blob on read. */
  attachmentBlobs!: Table<{ id: string; bytes: Uint8Array }, string>;

  constructor(name = "olaseena-db") {
    super(name);
    this.version(1).stores({
      members: "id, name, email, phone, status, updatedAt",
      trainers: "id, name, email, phone, status, updatedAt",
      courses: "id, title, trainerId, status, updatedAt",
      enrollments: "id, memberId, courseId, status, [memberId+courseId], [memberId+courseId+status], updatedAt",
      sessions: "id, courseId, date, [courseId+date], updatedAt",
      attendance: "id, sessionId, memberId, [sessionId+memberId], updatedAt",
      invoices: "id, number, memberId, status, dueDate, updatedAt",
      payments: "id, invoiceId, at, updatedAt",
      payrollRuns: "id, trainerId, periodStart, status, [trainerId+periodStart], updatedAt",
      auditLog: "id, at, entity, [entity+at]",
      writeKeys: "key, entity, createdAt",
      settings: "key",
    });
    // Version 2 adds the attachment metadata and blob stores. Listing every
    // version 1 store again keeps existing data in place during the upgrade.
    this.version(2).stores({
      members: "id, name, email, phone, status, updatedAt",
      trainers: "id, name, email, phone, status, updatedAt",
      courses: "id, title, trainerId, status, updatedAt",
      enrollments: "id, memberId, courseId, status, [memberId+courseId], [memberId+courseId+status], updatedAt",
      sessions: "id, courseId, date, [courseId+date], updatedAt",
      attendance: "id, sessionId, memberId, [sessionId+memberId], updatedAt",
      invoices: "id, number, memberId, status, dueDate, updatedAt",
      payments: "id, invoiceId, at, updatedAt",
      payrollRuns: "id, trainerId, periodStart, status, [trainerId+periodStart], updatedAt",
      auditLog: "id, at, entity, [entity+at]",
      writeKeys: "key, entity, createdAt",
      settings: "key",
      attachments: "id, [entityType+entityId], createdAt",
      attachmentBlobs: "id",
    });
    // Version 3 adds the trash store. Listing every version 2 store again
    // keeps existing data in place during the upgrade.
    this.version(3).stores({
      members: "id, name, email, phone, status, updatedAt",
      trainers: "id, name, email, phone, status, updatedAt",
      courses: "id, title, trainerId, status, updatedAt",
      enrollments: "id, memberId, courseId, status, [memberId+courseId], [memberId+courseId+status], updatedAt",
      sessions: "id, courseId, date, [courseId+date], updatedAt",
      attendance: "id, sessionId, memberId, [sessionId+memberId], updatedAt",
      invoices: "id, number, memberId, status, dueDate, updatedAt",
      payments: "id, invoiceId, at, updatedAt",
      payrollRuns: "id, trainerId, periodStart, status, [trainerId+periodStart], updatedAt",
      auditLog: "id, at, entity, [entity+at]",
      writeKeys: "key, entity, createdAt",
      settings: "key",
      attachments: "id, [entityType+entityId], createdAt",
      attachmentBlobs: "id",
      trash: "id, kind, originalId, deletedAt",
    });
    // Version 4 reshapes the schedule fields. Courses move from one weekday
    // to a list of weekdays, and sessions gain a start and end time; rows
    // written before then get an empty time, so their duration is unknown
    // rather than invented.
    this.version(4)
      .stores({
        members: "id, name, email, phone, status, updatedAt",
        trainers: "id, name, email, phone, status, updatedAt",
        courses: "id, title, trainerId, status, updatedAt",
        enrollments: "id, memberId, courseId, status, [memberId+courseId], [memberId+courseId+status], updatedAt",
        sessions: "id, courseId, date, [courseId+date], updatedAt",
        attendance: "id, sessionId, memberId, [sessionId+memberId], updatedAt",
        invoices: "id, number, memberId, status, dueDate, updatedAt",
        payments: "id, invoiceId, at, updatedAt",
        payrollRuns: "id, trainerId, periodStart, status, [trainerId+periodStart], updatedAt",
        auditLog: "id, at, entity, [entity+at]",
        writeKeys: "key, entity, createdAt",
        settings: "key",
        attachments: "id, [entityType+entityId], createdAt",
        attachmentBlobs: "id",
        trash: "id, kind, originalId, deletedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("courses")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!Array.isArray(row.scheduleWeekdays)) {
              row.scheduleWeekdays =
                typeof row.scheduleWeekday === "number" && Number.isInteger(row.scheduleWeekday) && row.scheduleWeekday >= 0 && row.scheduleWeekday <= 6
                  ? [row.scheduleWeekday]
                  : [];
            }
            delete row.scheduleWeekday;
          });
        await tx
          .table("sessions")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.startTime !== "string") row.startTime = "";
            if (typeof row.endTime !== "string") row.endTime = "";
          });
      });
    // Version 5 drops the course start time. A course keeps only its weekly
    // days; the time lives on each session instead.
    this.version(5)
      .stores({
        members: "id, name, email, phone, status, updatedAt",
        trainers: "id, name, email, phone, status, updatedAt",
        courses: "id, title, trainerId, status, updatedAt",
        enrollments: "id, memberId, courseId, status, [memberId+courseId], [memberId+courseId+status], updatedAt",
        sessions: "id, courseId, date, [courseId+date], updatedAt",
        attendance: "id, sessionId, memberId, [sessionId+memberId], updatedAt",
        invoices: "id, number, memberId, status, dueDate, updatedAt",
        payments: "id, invoiceId, at, updatedAt",
        payrollRuns: "id, trainerId, periodStart, status, [trainerId+periodStart], updatedAt",
        auditLog: "id, at, entity, [entity+at]",
        writeKeys: "key, entity, createdAt",
        settings: "key",
        attachments: "id, [entityType+entityId], createdAt",
        attachmentBlobs: "id",
        trash: "id, kind, originalId, deletedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("courses")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            delete row.scheduleTime;
          });
      });
  }
}
