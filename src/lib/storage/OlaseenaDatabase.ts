import Dexie, { type Table } from "dexie";
import type { Attachment } from "@/lib/domain/attachments";
import type { TrashEntry } from "@/lib/domain/trash";
import type {
  Attendance,
  AuditLogEntry,
  Course,
  Enrollment,
  ErrorLogRecord,
  Invoice,
  Member,
  Payment,
  PayrollRun,
  Session,
  SettingRecord,
  Trainer,
  WriteKey,
} from "@/lib/domain/types";

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
  trash!: Table<TrashEntry, string>;
  attachmentBlobs!: Table<{ id: string; bytes: Uint8Array }, string>;
  errorLog!: Table<ErrorLogRecord, string>;

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
    this.version(6)
      .stores({
        members: "id, name, email, phone, status, updatedAt",
        trainers: "id, name, email, phone, status, updatedAt",
        courses: "id, title, status, updatedAt",
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
            delete row.trainerId;
            delete row.capacity;
            if (!Array.isArray(row.requiredSkills)) row.requiredSkills = [];
          });
      });
    this.version(7).stores({
      members: "id, name, email, phone, status, updatedAt",
      trainers: "id, name, email, phone, status, updatedAt",
      courses: "id, title, status, updatedAt",
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
      errorLog: "id, time, code, action",
    });
  }
}
