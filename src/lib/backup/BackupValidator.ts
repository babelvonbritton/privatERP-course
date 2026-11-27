import type { Msg } from "@/i18n/types";
import { AppError } from "@/lib/errors/AppError";
import { CONTROL_RE, countChars, isRealDate } from "@/lib/storage/utils";
import {
  ATTENDANCE_STATUSES,
  COURSE_STATUSES,
  ENROLLMENT_STATUSES,
  INVOICE_STATUSES,
  LIMITS,
  MEMBER_STATUSES,
  PAYMENT_METHODS,
  PAYROLL_STATUSES,
  TRAINER_STATUSES,
  dedupeSkills,
  isCurrencyCode,
  sessionAttendees,
  type BackupData,
  type Attendance,
  type AuditLogEntry,
  type Course,
  type CurrencyCode,
  type Enrollment,
  type Invoice,
  type InvoiceLineItem,
  type Member,
  type Payment,
  type PayrollRun,
  type Session,
  type SettingRecord,
  type Trainer,
  type WriteKey,
} from "@/lib/domain/types";
import { ATTACHMENT_ENTITY_TYPES, MAX_ATTACHMENT_BYTES, type Attachment } from "@/lib/domain/attachments";
import { TRASH_KINDS, type TrashEntry } from "@/lib/domain/trash";
import { hasCurrencyPrecision } from "@/lib/currency";
import { moneyEquals, paidMatches } from "@/lib/money";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_STORE_NAMES, CONFIGURATION_NAME, DATA_NAME, DB_SCHEMA_VERSION, MAX_RECORDS_PER_STORE, STORE_NAMES, STORE_TO_FILE, type BackupStoreName, type StoreName } from "./constants";
import { BACKUP_KDF_ITERATIONS } from "./BackupCrypto";
import type { BackupEncryption, BackupKind, BackupManifest, BackupManifestFile } from "./types";

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SETTING_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const INVOICE_NUMBER_RE = /^INV-\d{8}-\d{3}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TIMESTAMP = 4_102_444_800_000;

class IssueLog {
  readonly lines: string[] = [];
  total = 0;
  add(path: string, message: string): void {
    this.total++;
    if (this.lines.length < 25) this.lines.push(`${path}: ${message}`);
  }
}

class FieldReader {
  constructor(private readonly log: IssueLog) {}

  id(o: Raw, key: string, path: string): string {
    const v = o[key];
    if (typeof v === "string" && ID_RE.test(v)) return v;
    this.log.add(`${path}.${key}`, "is not a valid id");
    return "";
  }

  text(o: Raw, key: string, path: string, max: number, opts: { required?: boolean; trim?: boolean } = {}): string {
    const v = o[key];
    if (typeof v !== "string") {
      this.log.add(`${path}.${key}`, "must be text");
      return "";
    }
    if (CONTROL_RE.test(v)) this.log.add(`${path}.${key}`, "contains control characters");
    if (countChars(v) > max) this.log.add(`${path}.${key}`, `is longer than ${max} characters`);
    if (opts.required && v.trim() === "") this.log.add(`${path}.${key}`, "is required");
    return opts.trim ? v.trim() : v;
  }

  email(o: Raw, key: string, path: string): string {
    const v = this.text(o, key, path, LIMITS.email, { trim: true });
    if (v !== "" && !EMAIL_RE.test(v)) this.log.add(`${path}.${key}`, "is not an email address");
    return v;
  }

  int(o: Raw, key: string, path: string, min: number, max: number): number {
    const v = o[key];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max) return v;
    this.log.add(`${path}.${key}`, `must be a whole number from ${min} to ${max}`);
    return min;
  }

  money(o: Raw, key: string, path: string, min: number, max: number, currency: CurrencyCode): number {
    const v = o[key];
    if (typeof v === "number" && hasCurrencyPrecision(v, currency) && v >= min && v <= max) return v;
    this.log.add(`${path}.${key}`, `must be a valid ${currency} amount from ${min} to ${max}`);
    return min;
  }

  bool(o: Raw, key: string, path: string): boolean {
    const v = o[key];
    if (typeof v === "boolean") return v;
    this.log.add(`${path}.${key}`, "must be true or false");
    return false;
  }

  oneOf<T extends string>(o: Raw, key: string, path: string, options: readonly T[]): T {
    const v = o[key];
    if (typeof v === "string" && (options as readonly string[]).includes(v)) return v as T;
    this.log.add(`${path}.${key}`, "is not an allowed value");
    return options[0];
  }

  date(o: Raw, key: string, path: string): string | null {
    const v = o[key];
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v)) return v;
    this.log.add(`${path}.${key}`, "is not a valid date");
    return null;
  }

  time(o: Raw, key: string, path: string): string {
    const v = o[key];
    if (typeof v === "string" && TIME_RE.test(v)) return v;
    this.log.add(`${path}.${key}`, "must be a time like 09:00");
    return "00:00";
  }

  /** A time that may be absent: rows written before time ranges existed carry none, and that is not a problem. */
  timeOptional(o: Raw, key: string, path: string): string {
    const v = o[key];
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "string" && TIME_RE.test(v)) return v;
    this.log.add(`${path}.${key}`, "must be a time like 09:00");
    return "";
  }

  /** Whole numbers in range, deduplicated and sorted, for weekday lists. */
  intList(o: Raw, key: string, path: string, min: number, max: number): number[] {
    const v = o[key];
    if (!Array.isArray(v)) {
      this.log.add(`${path}.${key}`, "must be a list");
      return [];
    }
    const out: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const entry = v[i];
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < min || entry > max) {
        this.log.add(`${path}.${key}[${i}]`, `must be a whole number from ${min} to ${max}`);
        continue;
      }
      if (!out.includes(entry)) out.push(entry);
    }
    return out.sort((a, b) => a - b);
  }

  stringList(o: Raw, key: string, path: string, maxItems: number, maxLen: number): string[] {
    const v = o[key];
    if (!Array.isArray(v)) {
      this.log.add(`${path}.${key}`, "must be a list");
      return [];
    }
    if (v.length > maxItems) this.log.add(`${path}.${key}`, `has more than ${maxItems} entries`);
    return v.map((entry, i) => {
      if (typeof entry !== "string") {
        this.log.add(`${path}.${key}[${i}]`, "must be text");
        return "";
      }
      if (countChars(entry) > maxLen) this.log.add(`${path}.${key}[${i}]`, `is longer than ${maxLen} characters`);
      return entry;
    });
  }

  /** Record ids from a list, deduplicated, dropping blank entries (non-text entries are already logged by stringList). */
  idList(o: Raw, key: string, path: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of this.stringList(o, key, path, 10_000, 64)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  }

  nullableInt(o: Raw, key: string, path: string, min: number, max: number): number | null {
    const v = o[key];
    if (v === null || v === undefined) return null;
    return this.int(o, key, path, min, max);
  }
}

interface ValidationResult {
  data: BackupData;
  warnings: Msg[];
  total: number;
}

const FIELDS = {
  member: ["id", "orgId", "ownerId", "name", "email", "phone", "notes", "status", "createdAt", "updatedAt", "rev"],
  trainer: ["id", "orgId", "ownerId", "name", "email", "phone", "subjects", "ratePerSession", "status", "createdAt", "updatedAt", "rev"],
  course: ["id", "orgId", "ownerId", "title", "description", "level", "price", "capacity", "trainerId", "requiredSkills", "scheduleWeekdays", "scheduleWeekday", "scheduleTime", "status", "createdAt", "updatedAt", "rev"],
  enrollment: ["id", "orgId", "ownerId", "memberId", "courseId", "startDate", "endDate", "status", "createdAt", "updatedAt", "rev"],
  session: ["id", "orgId", "ownerId", "courseId", "date", "topic", "trainerId", "trainerPresent", "startTime", "endTime", "capacity", "attendeeMemberIds", "createdAt", "updatedAt", "rev"],
  attendance: ["id", "orgId", "ownerId", "sessionId", "memberId", "status", "createdAt", "updatedAt", "rev"],
  invoice: ["id", "orgId", "ownerId", "number", "memberId", "enrollmentId", "lineItems", "total", "paidAmount", "dueDate", "status", "paymentMethod", "paymentDetails", "createdAt", "updatedAt", "rev"],
  payment: ["id", "orgId", "ownerId", "invoiceId", "amount", "at", "method", "createdAt", "updatedAt", "rev"],
  payrollRun: ["id", "orgId", "ownerId", "trainerId", "periodStart", "periodEnd", "sessionIds", "sessionCount", "ratePerSession", "total", "status", "paidAt", "createdAt", "updatedAt", "rev"],
  auditLog: ["id", "orgId", "actorId", "actorName", "action", "entity", "entityId", "detail", "at"],
  writeKey: ["key", "entity", "entityId", "createdAt"],
  setting: ["key", "value"],
  attachment: ["id", "entityType", "entityId", "fileName", "mimeType", "sizeBytes", "width", "height", "createdAt"],
  trash: ["id", "kind", "originalId", "label", "snapshot", "related", "deletedAt"],
} as const;

class DataValidation {
  private readonly log = new IssueLog();
  private readonly read = new FieldReader(this.log);
  private unknownFieldRecords = 0;
  private currency: CurrencyCode = "IDR";

  constructor(private readonly now: number) {}

  run(raw: unknown): ValidationResult {
    if (!isRecord(raw)) throw this.fail("data.json must be an object");
    const lists = {} as Record<StoreName, unknown[]>;
    for (const name of STORE_NAMES) {
      const v = raw[name];
      if (!Array.isArray(v)) {
        this.log.add(name, "must be a list");
        lists[name] = [];
      } else if (v.length > MAX_RECORDS_PER_STORE) {
        this.log.add(name, `has more than ${MAX_RECORDS_PER_STORE} records`);
        lists[name] = [];
      } else lists[name] = v;
    }
    const rawAttachments = raw.attachments;
    const attachmentList: unknown[] = rawAttachments === undefined ? [] : Array.isArray(rawAttachments) ? rawAttachments : (this.log.add("attachments", "must be a list"), []);
    const rawTrash = raw.trash;
    const trashList: unknown[] = rawTrash === undefined ? [] : Array.isArray(rawTrash) ? rawTrash : (this.log.add("trash", "must be a list"), []);
    const currencySetting = lists.settings.find((entry) => isRecord(entry) && entry.key === "pref.currency");
    if (isRecord(currencySetting) && isCurrencyCode(currencySetting.value)) this.currency = currencySetting.value;

    const members = this.each(lists.members, "members", FIELDS.member, this.member);
    const trainers = this.each(lists.trainers, "trainers", FIELDS.trainer, this.trainer);
    const courses = this.each(lists.courses, "courses", FIELDS.course, this.course);
    const enrollments = this.each(lists.enrollments, "enrollments", FIELDS.enrollment, this.enrollment);
    const sessions = this.each(lists.sessions, "sessions", FIELDS.session, this.session);
    const attendance = this.each(lists.attendance, "attendance", FIELDS.attendance, this.attendance);
    const invoices = this.each(lists.invoices, "invoices", FIELDS.invoice, this.invoice);
    const payments = this.each(lists.payments, "payments", FIELDS.payment, this.payment);
    const payrollRuns = this.each(lists.payrollRuns, "payrollRuns", FIELDS.payrollRun, this.payrollRun);
    const auditLog = this.each(lists.auditLog, "auditLog", FIELDS.auditLog, this.auditEntry);
    const writeKeys = this.each(lists.writeKeys, "writeKeys", FIELDS.writeKey, this.writeKey);
    const settings = this.each(lists.settings, "settings", FIELDS.setting, this.setting);
    const attachments = this.each(attachmentList, "attachments", FIELDS.attachment, this.attachment);
    const trash = this.each(trashList, "trash", FIELDS.trash, this.trashEntry);

    this.unique(members, "members", (m) => m.id);
    this.unique(trainers, "trainers", (t) => t.id);
    this.unique(courses, "courses", (c) => c.id);
    this.unique(enrollments, "enrollments", (e) => e.id);
    this.unique(sessions, "sessions", (s) => s.id);
    this.unique(attendance, "attendance", (a) => a.id);
    this.unique(invoices, "invoices", (i) => i.id);
    this.unique(payments, "payments", (p) => p.id);
    this.unique(payrollRuns, "payrollRuns", (r) => r.id);
    this.unique(auditLog, "auditLog", (a) => a.id);
    this.unique(writeKeys, "writeKeys", (w) => w.key);
    this.unique(settings, "settings", (s) => s.key);
    this.unique(attachments, "attachments", (a) => a.id);
    this.unique(trash, "trash", (t) => t.id);

    const memberIds = new Set(members.map((m) => m.id));
    const trainerIds = new Set(trainers.map((t) => t.id));
    const courseIds = new Set(courses.map((c) => c.id));
    const enrollmentIds = new Set(enrollments.map((e) => e.id));
    const sessionIds = new Set(sessions.map((s) => s.id));
    const invoiceIds = new Set(invoices.map((i) => i.id));

    enrollments.forEach((e, i) => {
      if (!memberIds.has(e.memberId)) this.log.add(`enrollments[${i}].memberId`, "points to a missing member");
      if (!courseIds.has(e.courseId)) this.log.add(`enrollments[${i}].courseId`, "points to a missing course");
    });
    sessions.forEach((s, i) => {
      if (!courseIds.has(s.courseId)) this.log.add(`sessions[${i}].courseId`, "points to a missing course");
      if (!trainerIds.has(s.trainerId)) this.log.add(`sessions[${i}].trainerId`, "points to a missing trainer");
      (sessionAttendees(s) ?? []).forEach((id, j) => {
        if (!memberIds.has(id)) this.log.add(`sessions[${i}].attendeeMemberIds[${j}]`, "points to a missing member");
      });
    });
    attendance.forEach((a, i) => {
      if (!sessionIds.has(a.sessionId)) this.log.add(`attendance[${i}].sessionId`, "points to a missing session");
      if (!memberIds.has(a.memberId)) this.log.add(`attendance[${i}].memberId`, "points to a missing member");
    });
    invoices.forEach((i, idx) => {
      if (!memberIds.has(i.memberId)) this.log.add(`invoices[${idx}].memberId`, "points to a missing member");
      if (i.enrollmentId !== null && !enrollmentIds.has(i.enrollmentId)) this.log.add(`invoices[${idx}].enrollmentId`, "points to a missing enrollment");
      const sum = i.lineItems.reduce((s, item) => s + item.amount, 0);
      if (!moneyEquals(sum, i.total, this.currency)) this.log.add(`invoices[${idx}].total`, "does not match its line items");
    });
    payments.forEach((p, i) => { if (!invoiceIds.has(p.invoiceId)) this.log.add(`payments[${i}].invoiceId`, "points to a missing invoice"); });
    payrollRuns.forEach((r, i) => {
      if (!trainerIds.has(r.trainerId)) this.log.add(`payrollRuns[${i}].trainerId`, "points to a missing trainer");
      r.sessionIds.forEach((sid, j) => { if (!sessionIds.has(sid)) this.log.add(`payrollRuns[${i}].sessionIds[${j}]`, "points to a missing session"); });
      if (r.sessionIds.length !== r.sessionCount) this.log.add(`payrollRuns[${i}].sessionCount`, "does not match its sessions");
      if (!moneyEquals(r.sessionCount * r.ratePerSession, r.total, this.currency)) this.log.add(`payrollRuns[${i}].total`, "does not match sessions × rate");
    });
    const numbers = new Set<string>();
    invoices.forEach((i, idx) => {
      if (numbers.has(i.number)) this.log.add(`invoices[${idx}].number`, "is used by two invoices");
      numbers.add(i.number);
    });
    const paidByInvoice = new Map<string, number>();
    for (const p of payments) paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + p.amount);
    invoices.forEach((i, idx) => {
      if (!paidMatches(paidByInvoice.get(i.id) ?? 0, i.paidAmount, this.currency)) this.log.add(`invoices[${idx}].paidAmount`, "does not match its payments");
    });
    const trashedInvoiceIds = new Set(trash.filter((t) => t.kind === "invoice").map((t) => t.originalId));
    attachments.forEach((a, idx) => {
      const pointsAtInvoice = a.entityType === "invoice" && (invoiceIds.has(a.entityId) || trashedInvoiceIds.has(a.entityId));
      const known = a.entityType === "invoice" ? pointsAtInvoice : a.entityType === "member" ? memberIds.has(a.entityId) : a.entityType === "session" ? sessionIds.has(a.entityId) : a.entityType === "profile" && a.entityId === "profile";
      if (!known) this.log.add(`attachments[${idx}].entityId`, "points to a missing record");
    });
    if (this.log.total > 0) throw this.fail();

    const warnings: Msg[] = [];
    if (this.unknownFieldRecords > 0) warnings.push({ key: "warn.unknownFields", vars: { count: this.unknownFieldRecords } });

    const total = members.length + trainers.length + courses.length + enrollments.length + sessions.length + attendance.length + invoices.length + payments.length + payrollRuns.length + auditLog.length + writeKeys.length + settings.length + attachments.length + trash.length;
    return { data: { members, trainers, courses, enrollments, sessions, attendance, invoices, payments, payrollRuns, auditLog, writeKeys, settings, attachments, trash }, warnings, total };
  }

  private fail(summary?: string): AppError {
    const lines = summary ? [summary, ...this.log.lines] : this.log.lines;
    const extra = this.log.total > this.log.lines.length ? `\n...and ${this.log.total - this.log.lines.length} more` : "";
    return new AppError("BACKUP_STRUCTURE_INVALID", { details: lines.join("\n") + extra, context: { issues: this.log.total } });
  }

  private each<T>(list: unknown[], path: string, allowed: readonly string[], build: (o: Raw, path: string) => T): T[] {
    const out: T[] = [];
    list.forEach((entry, i) => {
      const at = `${path}[${i}]`;
      if (!isRecord(entry)) {
        this.log.add(at, "must be an object");
        return;
      }
      if (Object.keys(entry).some((k) => !allowed.includes(k))) this.unknownFieldRecords++;
      out.push(build(entry, at));
    });
    return out;
  }

  private unique<T>(list: T[], path: string, key: (v: T) => string): void {
    const seen = new Set<string>();
    list.forEach((v, i) => {
      const k = key(v);
      if (k && seen.has(k)) this.log.add(`${path}[${i}]`, `duplicate id ${k}`);
      seen.add(k);
    });
  }

  private base = (o: Raw, p: string) => ({
    id: this.read.id(o, "id", p),
    orgId: this.read.text(o, "orgId", p, 64, { required: true, trim: true }),
    ownerId: this.read.text(o, "ownerId", p, 64, { required: true, trim: true }),
    createdAt: this.read.int(o, "createdAt", p, 0, MAX_TIMESTAMP),
    updatedAt: this.read.int(o, "updatedAt", p, 0, MAX_TIMESTAMP),
    rev: this.read.int(o, "rev", p, 1, 1_000_000_000),
  });

  private member = (o: Raw, p: string): Member => ({
    ...this.base(o, p),
    name: this.read.text(o, "name", p, LIMITS.name, { required: true, trim: true }),
    email: this.read.email(o, "email", p),
    phone: this.read.text(o, "phone", p, LIMITS.phone, { trim: true }),
    notes: this.read.text(o, "notes", p, LIMITS.notes),
    status: this.read.oneOf(o, "status", p, MEMBER_STATUSES),
  });

  private trainer = (o: Raw, p: string): Trainer => ({
    ...this.base(o, p),
    name: this.read.text(o, "name", p, LIMITS.name, { required: true, trim: true }),
    email: this.read.email(o, "email", p),
    phone: this.read.text(o, "phone", p, LIMITS.phone, { trim: true }),
    subjects: this.read.stringList(o, "subjects", p, LIMITS.subjects, LIMITS.subject),
    ratePerSession: this.read.money(o, "ratePerSession", p, 0, 100_000_000, this.currency),
    status: this.read.oneOf(o, "status", p, TRAINER_STATUSES),
  });

  private course = (o: Raw, p: string): Course => ({
    ...this.base(o, p),
    title: this.read.text(o, "title", p, LIMITS.courseTitle, { required: true, trim: true }),
    description: this.read.text(o, "description", p, LIMITS.description),
    level: this.read.text(o, "level", p, LIMITS.level, { required: true, trim: true }),
    price: this.read.money(o, "price", p, 0, 1_000_000_000, this.currency),
    requiredSkills: o.requiredSkills === undefined ? [] : dedupeSkills(this.read.stringList(o, "requiredSkills", p, LIMITS.requiredSkills, LIMITS.subject)),
    scheduleWeekdays: this.weekdays(o, p),
    status: this.read.oneOf(o, "status", p, COURSE_STATUSES),
  });

  /** Weekdays from the list when present; a backup written before the list existed carries one weekday instead. */
  private weekdays(o: Raw, p: string): number[] {
    if (Array.isArray(o.scheduleWeekdays)) return this.read.intList(o, "scheduleWeekdays", p, 0, 6);
    const legacy = o.scheduleWeekday;
    if (typeof legacy === "number" && Number.isSafeInteger(legacy) && legacy >= 0 && legacy <= 6) return [legacy];
    if (legacy !== undefined && legacy !== null) this.read.int(o, "scheduleWeekday", p, 0, 6);
    return [];
  }

  private enrollment = (o: Raw, p: string): Enrollment => ({
    ...this.base(o, p),
    memberId: this.read.id(o, "memberId", p),
    courseId: this.read.id(o, "courseId", p),
    startDate: this.read.date(o, "startDate", p) ?? "",
    endDate: this.read.date(o, "endDate", p),
    status: this.read.oneOf(o, "status", p, ENROLLMENT_STATUSES),
  });

  private session = (o: Raw, p: string): Session => ({
    ...this.base(o, p),
    courseId: this.read.id(o, "courseId", p),
    date: this.read.date(o, "date", p) ?? "",
    topic: this.read.text(o, "topic", p, LIMITS.topic, { required: true, trim: true }),
    trainerId: this.read.id(o, "trainerId", p),
    trainerPresent: this.read.bool(o, "trainerPresent", p),
    startTime: this.read.timeOptional(o, "startTime", p),
    endTime: this.read.timeOptional(o, "endTime", p),
    capacity: o.capacity === undefined || o.capacity === null ? null : this.read.int(o, "capacity", p, 1, 10_000),
    attendeeMemberIds: o.attendeeMemberIds === undefined || o.attendeeMemberIds === null ? null : this.read.idList(o, "attendeeMemberIds", p),
  });

  private attendance = (o: Raw, p: string): Attendance => ({
    ...this.base(o, p),
    sessionId: this.read.id(o, "sessionId", p),
    memberId: this.read.id(o, "memberId", p),
    status: this.read.oneOf(o, "status", p, ATTENDANCE_STATUSES),
  });

  private invoice = (o: Raw, p: string): Invoice => {
    const lineItems: InvoiceLineItem[] = [];
    const rawItems = o.lineItems;
    if (!Array.isArray(rawItems)) this.log.add(`${p}.lineItems`, "must be a list");
    else {
      if (rawItems.length < 1 || rawItems.length > LIMITS.lineItems) this.log.add(`${p}.lineItems`, `must have 1 to ${LIMITS.lineItems} items`);
      rawItems.forEach((entry, i) => {
        if (!isRecord(entry)) {
          this.log.add(`${p}.lineItems[${i}]`, "must be an object");
          return;
        }
        lineItems.push({
          description: this.read.text(entry, "description", `${p}.lineItems[${i}]`, LIMITS.lineDescription, { required: true, trim: true }),
          amount: this.read.money(entry, "amount", `${p}.lineItems[${i}]`, 0, 1_000_000_000, this.currency),
        });
      });
    }
    const number = typeof o.number === "string" && INVOICE_NUMBER_RE.test(o.number) ? o.number : "";
    if (!number) this.log.add(`${p}.number`, "must look like INV-YYYYMMDD-###");
    return {
      ...this.base(o, p),
      number,
      memberId: this.read.id(o, "memberId", p),
      enrollmentId: (() => {
        const v = o.enrollmentId;
        if (v === null || v === undefined) return null;
        return this.read.id(o, "enrollmentId", p);
      })(),
      lineItems,
      total: this.read.money(o, "total", p, 0, 1_000_000_000, this.currency),
      paidAmount: this.read.money(o, "paidAmount", p, 0, 1_000_000_000, this.currency),
      dueDate: this.read.date(o, "dueDate", p) ?? "",
      status: this.read.oneOf(o, "status", p, INVOICE_STATUSES),
      paymentMethod: o.paymentMethod === undefined ? "cash" : this.read.oneOf(o, "paymentMethod", p, PAYMENT_METHODS),
      paymentDetails: o.paymentDetails === undefined ? "" : this.read.text(o, "paymentDetails", p, LIMITS.paymentDetails, { trim: true }),
    };
  };

  private payment = (o: Raw, p: string): Payment => ({
    ...this.base(o, p),
    invoiceId: this.read.id(o, "invoiceId", p),
    amount: this.read.money(o, "amount", p, 1, 1_000_000_000, this.currency),
    at: this.read.int(o, "at", p, 0, MAX_TIMESTAMP),
    method: this.read.oneOf(o, "method", p, PAYMENT_METHODS),
  });

  private payrollRun = (o: Raw, p: string): PayrollRun => ({
    ...this.base(o, p),
    trainerId: this.read.id(o, "trainerId", p),
    periodStart: this.read.date(o, "periodStart", p) ?? "",
    periodEnd: this.read.date(o, "periodEnd", p) ?? "",
    sessionIds: this.read.stringList(o, "sessionIds", p, 10_000, 64),
    sessionCount: this.read.int(o, "sessionCount", p, 0, 10_000),
    ratePerSession: this.read.money(o, "ratePerSession", p, 0, 100_000_000, this.currency),
    total: this.read.money(o, "total", p, 0, 1_000_000_000, this.currency),
    status: this.read.oneOf(o, "status", p, PAYROLL_STATUSES),
    paidAt: this.read.nullableInt(o, "paidAt", p, 0, MAX_TIMESTAMP),
  });

  private auditEntry = (o: Raw, p: string): AuditLogEntry => ({
    id: this.read.id(o, "id", p),
    orgId: this.read.text(o, "orgId", p, 64, { required: true, trim: true }),
    actorId: this.read.text(o, "actorId", p, 64, { required: true, trim: true }),
    actorName: this.read.text(o, "actorName", p, 80, { required: true, trim: true }),
    action: this.read.text(o, "action", p, 80, { required: true, trim: true }),
    entity: this.read.text(o, "entity", p, 40, { required: true, trim: true }),
    entityId: this.read.id(o, "entityId", p),
    detail: this.read.text(o, "detail", p, LIMITS.detail),
    at: this.read.int(o, "at", p, 0, MAX_TIMESTAMP),
  });

  private writeKey = (o: Raw, p: string): WriteKey => {
    const key = typeof o.key === "string" && KEY_RE.test(o.key) ? o.key : "";
    if (!key) this.log.add(`${p}.key`, "is not a valid key");
    return {
      key,
      entity: this.read.text(o, "entity", p, 40, { required: true, trim: true }),
      entityId: this.read.id(o, "entityId", p),
      createdAt: this.read.int(o, "createdAt", p, 0, MAX_TIMESTAMP),
    };
  };

  private setting = (o: Raw, p: string): SettingRecord => {
    const key = typeof o.key === "string" && SETTING_KEY_RE.test(o.key) ? o.key : "";
    if (!key) this.log.add(`${p}.key`, "is not a valid setting key");
    const v = o.value;
    let value: SettingRecord["value"] = null;
    if (v === null || typeof v === "boolean") value = v;
    else if (typeof v === "number" && Number.isFinite(v)) value = v;
    else if (typeof v === "string" && v.length <= 1000 && !CONTROL_RE.test(v)) value = v;
    else this.log.add(`${p}.value`, "is not an allowed value");
    return { key, value };
  };

  private trashEntry = (o: Raw, p: string): TrashEntry => {
    let snapshot: unknown = {};
    if (isRecord(o.snapshot)) snapshot = o.snapshot;
    else this.log.add(`${p}.snapshot`, "must be an object");
    let related: unknown[] = [];
    if (Array.isArray(o.related)) related = o.related;
    else this.log.add(`${p}.related`, "must be a list");
    return {
      id: this.read.id(o, "id", p),
      kind: this.read.oneOf(o, "kind", p, TRASH_KINDS),
      originalId: this.read.id(o, "originalId", p),
      label: this.read.text(o, "label", p, 200, { required: true, trim: true }),
      snapshot,
      related,
      deletedAt: this.read.int(o, "deletedAt", p, 0, MAX_TIMESTAMP),
    };
  };

  private attachment = (o: Raw, p: string): Attachment => {
    const mimeType = this.read.text(o, "mimeType", p, 127, { required: true, trim: true });
    if (mimeType !== "" && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) this.log.add(`${p}.mimeType`, "is not a media type");
    return {
      id: this.read.id(o, "id", p),
      entityType: this.read.oneOf(o, "entityType", p, ATTACHMENT_ENTITY_TYPES),
      entityId: this.read.id(o, "entityId", p),
      fileName: this.read.text(o, "fileName", p, 255, { required: true, trim: true }),
      mimeType,
      sizeBytes: this.read.int(o, "sizeBytes", p, 0, MAX_ATTACHMENT_BYTES),
      width: this.read.int(o, "width", p, 0, 65535),
      height: this.read.int(o, "height", p, 0, 65535),
      createdAt: this.read.int(o, "createdAt", p, 0, MAX_TIMESTAMP),
    };
  };
}

export class BackupValidator {
  /**
   * Checks manifest.json structure and version compatibility. Accepts format
   * 1 (manifest.json + data.json) and format 2 (one NDJSON file per store,
   * settings/configuration.json, and optional asset files). A newer format
   * is refused as unsupported; anything else malformed is refused as invalid.
   */
  static validateManifest(raw: unknown): BackupManifest {
    if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
      throw new AppError("BACKUP_MANIFEST_INVALID", { details: `format must be "${BACKUP_FORMAT}"` });
    }
    const log = new IssueLog();
    const read = new FieldReader(log);
    const formatVersion = read.int(raw, "formatVersion", "manifest", 1, 10_000);
    const schemaVersion = read.int(raw, "schemaVersion", "manifest", 1, 10_000);
    const kind = read.oneOf<BackupKind>(raw, "kind", "manifest", ["backup", "safety"]);
    let currency: CurrencyCode = "IDR";
    if (raw.currency !== undefined) {
      if (isCurrencyCode(raw.currency)) currency = raw.currency;
      else log.add("manifest.currency", "is not a supported currency");
    }
    const createdAtMs = read.int(raw, "createdAtMs", "manifest", 0, MAX_TIMESTAMP);
    const createdAt = read.text(raw, "createdAt", "manifest", 40);
    const app = isRecord(raw.app) ? { name: read.text(raw.app, "name", "manifest.app", 40), version: read.text(raw.app, "version", "manifest.app", 20) } : (log.add("manifest.app", "must be an object"), { name: "", version: "" });

    const stores = {} as BackupManifest["stores"];
    const rawStores = isRecord(raw.stores) ? raw.stores : (log.add("manifest.stores", "must be an object"), {} as Raw);
    const trashStoreMissing = !isRecord(rawStores.trash);
    for (const name of BACKUP_STORE_NAMES) {
      const s = rawStores[name];
      if (!isRecord(s)) {
        if ((formatVersion === 1 && name === "attachments") || name === "trash") {
          stores[name] = { count: 0, sha256: "" };
          continue;
        }
        log.add(`manifest.stores.${name}`, "is missing");
        stores[name] = { count: 0, sha256: "" };
        continue;
      }
      const hash = typeof s.sha256 === "string" && HASH_RE.test(s.sha256) ? s.sha256 : (log.add(`manifest.stores.${name}.sha256`, "is not a SHA-256 hash"), "");
      stores[name] = { count: read.int(s, "count", `manifest.stores.${name}`, 0, MAX_RECORDS_PER_STORE), sha256: hash };
    }

    const files: BackupManifestFile[] = [];
    const readFileEntry = (f: Raw, at: string): BackupManifestFile => {
      const name = typeof f.name === "string" ? f.name : (log.add(`${at}.name`, "must be text"), "");
      const hash = typeof f.sha256 === "string" && HASH_RE.test(f.sha256) ? f.sha256 : (log.add(`${at}.sha256`, "is not a SHA-256 hash"), "");
      const entry: BackupManifestFile = { name, bytes: read.int(f, "bytes", at, 0, 50 * 1024 * 1024), sha256: hash };
      if (typeof f.iv === "string") {
        if (/^[0-9a-f]{24}$/.test(f.iv)) entry.iv = f.iv;
        else log.add(`${at}.iv`, "must be 12 bytes of lowercase hex");
      }
      return entry;
    };
    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      log.add("manifest.files", "must list the archive files");
    } else if (formatVersion === 1) {
      if (raw.files.length === 1 && isRecord(raw.files[0]) && raw.files[0].name === DATA_NAME) files.push(readFileEntry(raw.files[0], "manifest.files[0]"));
      else log.add("manifest.files", `must list exactly ${DATA_NAME}`);
    } else {
      const seenNames = new Set<string>();
      raw.files.forEach((entry, i) => {
        if (!isRecord(entry)) {
          log.add(`manifest.files[${i}]`, "must be an object");
          return;
        }
        const parsed = readFileEntry(entry, `manifest.files[${i}]`);
        if (parsed.name !== "") {
          if (seenNames.has(parsed.name)) log.add(`manifest.files[${i}].name`, "is listed twice");
          seenNames.add(parsed.name);
        }
        files.push(parsed);
      });
      for (const name of BACKUP_STORE_NAMES) {
        const path = STORE_TO_FILE[name];
        const entry = files.find((f) => f.name === path);
        if (!entry) {
          if (name === "trash" && trashStoreMissing) continue;
          log.add("manifest.files", `is missing ${path}`);
        } else if (entry.sha256 !== stores[name].sha256) log.add(`manifest.files`, `checksum for ${path} does not match its store record`);
      }
      for (const entry of files) {
        const isStoreFile = (Object.values(STORE_TO_FILE) as string[]).includes(entry.name);
        if (!isStoreFile && !entry.name.startsWith("assets/images/")) {
          log.add("manifest.files", `unexpected file: ${entry.name.slice(0, 80)}`);
        }
      }
    }

    let encryption: BackupEncryption | undefined;
    if ("encryption" in raw) {
      if (!isRecord(raw.encryption)) {
        log.add("manifest.encryption", "must be an object");
      } else {
        const info = raw.encryption;
        if (info.algorithm !== "AES-GCM") log.add("manifest.encryption.algorithm", "is not supported");
        if (info.kdf !== "PBKDF2-SHA-256") log.add("manifest.encryption.kdf", "is not supported");
        const iterations = read.int(info, "iterations", "manifest.encryption", BACKUP_KDF_ITERATIONS, BACKUP_KDF_ITERATIONS);
        const salt = typeof info.salt === "string" && /^[0-9a-f]{32}$/.test(info.salt) ? info.salt : (log.add("manifest.encryption.salt", "must be 16 bytes of lowercase hex"), "");
        if (formatVersion === 1) {
          const iv = typeof info.iv === "string" && /^[0-9a-f]{24}$/.test(info.iv) ? info.iv : (log.add("manifest.encryption.iv", "must be 12 bytes of lowercase hex"), "");
          encryption = { algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations, salt, iv };
        } else {
          if ("iv" in info) log.add("manifest.encryption.iv", "must live on each file entry in format 2");
          encryption = { algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations, salt };
        }
      }
    }
    if (formatVersion === 2) {
      for (const entry of files) {
        if (encryption && !entry.iv) log.add(`manifest.files`, `${entry.name} has no IV but the backup is encrypted`);
        if (!encryption && entry.iv) log.add(`manifest.files`, `${entry.name} has an IV but the backup is not encrypted`);
      }
    }

    if (log.total > 0) throw new AppError("BACKUP_MANIFEST_INVALID", { details: log.lines.join("\n") });
    if (formatVersion > BACKUP_FORMAT_VERSION) {
      throw new AppError("BACKUP_UNSUPPORTED_VERSION", { details: `Backup format ${formatVersion}, schema ${schemaVersion}. This app supports format ${BACKUP_FORMAT_VERSION}, schema ${DB_SCHEMA_VERSION}.` });
    }
    if (schemaVersion > DB_SCHEMA_VERSION) {
      throw new AppError("BACKUP_UNSUPPORTED_VERSION", { details: `Backup format ${formatVersion}, schema ${schemaVersion}. This app supports format ${BACKUP_FORMAT_VERSION}, schema ${DB_SCHEMA_VERSION}.` });
    }
    return { format: BACKUP_FORMAT, formatVersion, schemaVersion, kind, app, currency, createdAt, createdAtMs, stores, files, ...(encryption ? { encryption } : {}) };
  }

  /** Validates data.json contents and returns a clean copy plus notices about repairs. */
  static validateData(raw: unknown, now = Date.now()): ValidationResult {
    return new DataValidation(now).run(raw);
  }
}
