import { AppError } from "@/lib/errors/AppError";
import { ValidationError } from "@/lib/storage/Guard";
import { createId } from "@/lib/storage/utils";
import { monthRange, todayIso } from "@/lib/dates";
import { nextInvoiceNumber } from "@/lib/money";
import { DAILY_SWITCH_LIMIT, convert, fetchRate, localDateString, setCurrency } from "@/lib/currency";
import { PREFERENCE_KEYS } from "@/lib/storage/PreferenceService";
import type { StorageService } from "@/lib/storage";
import { getStorage } from "@/lib/storage";
import type { Clock } from "@/lib/storage/types";
import {
  attendanceInput,
  courseInput,
  coursePatch,
  enrollmentInput,
  enrollmentPatch,
  invoiceInput,
  invoicePatch,
  memberInput,
  memberPatch,
  parseInput,
  paymentInput,
  payrollInput,
  payrollPatch,
  sessionInput,
  trainerInput,
  trainerPatch,
  type AttendanceInput,
  type CourseInput,
  type CoursePatch,
  type EnrollmentInput,
  type EnrollmentPatch,
  type InvoiceInput,
  type InvoicePatch,
  type MemberInput,
  type MemberPatch,
  type PaymentInput,
  type PayrollInput,
  type PayrollPatch,
  type SessionInput,
  type TrainerInput,
  type TrainerPatch,
} from "./schemas";
import { requireCan } from "./permissions";
import { createTrashEntry } from "./trash";
import { TrashService } from "./trashService";
import { AttachmentService } from "@/lib/attachments/service";
import type {
  Actor,
  Attendance,
  AttendanceStatus,
  AuditLogEntry,
  BaseRecord,
  Course,
  CurrencyCode,
  Enrollment,
  Invoice,
  InvoiceDisplayStatus,
  InvoiceStatus,
  Member,
  Payment,
  PayrollRun,
  Session,
  Trainer,
} from "./types";
import { ORG_ID, OWNER_ACTOR, courseWeekdays, dateWeekday, dedupeSkills, sessionDurationHours } from "./types";
import { paymentDetailsOf, paymentMethodOf } from "@/lib/invoicePayment";

/**
 * All writes go through these services. Each one: validates input with zod at the
 * boundary, checks the permission gate, honors the idempotency key inside the same
 * Dexie transaction as the write, and appends an audit entry. The UI layer never
 * touches a store directly.
 */

type Db = StorageService["db"];

function baseFields(actor: Actor, now: number, id = createId()): BaseRecord {
  return { id, orgId: actor.orgId, ownerId: actor.id, createdAt: now, updatedAt: now, rev: 1 };
}

function touched<T extends BaseRecord>(record: T, now: number): T {
  return { ...record, updatedAt: now, rev: record.rev + 1 };
}

/**
 * Rejects a date outside the course's weekly slot, naming the allowed weekdays
 * as numbers so the error text can be translated at display time. A course with
 * no scheduled days accepts any date, so legacy rows without a schedule stay usable.
 */
function assertDateOnSchedule(field: string, date: string, course: Course): void {
  const days = courseWeekdays(course);
  if (days.length === 0) return;
  const weekday = dateWeekday(date);
  if (weekday === null) throw new ValidationError(field, `${field} is not a valid date`, "invalid");
  if (!days.includes(weekday)) {
    throw new ValidationError(field, `${field} is not one of the course's scheduled weekdays`, "notScheduledDay", undefined, { days: days.join(",") });
  }
}

abstract class ServiceBase {
  constructor(
    protected readonly storage: StorageService,
    protected readonly actor: Actor,
    protected readonly clock: Clock = Date.now,
  ) {}

  protected get db(): Db {
    return this.storage.db;
  }

  protected now(): number {
    return this.clock();
  }

  protected async audit(action: string, entity: string, entityId: string, detail: string): Promise<void> {
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

  /** Returns the entity id a write key already produced, or null when the key is new. */
  protected async seenKey(key: string, entity: string): Promise<string | null> {
    const seen = await this.storage.writeKeys.get(key);
    return seen && seen.entity === entity ? seen.entityId : null;
  }

  protected async recordKey(key: string, entity: string, entityId: string): Promise<void> {
    await this.storage.writeKeys.put({ key, entity, entityId, createdAt: this.now() });
  }
}

/** "overdue" is derived, never stored: an open invoice past its due date. */
export function effectiveInvoiceStatus(invoice: Invoice, today: string): InvoiceDisplayStatus {
  if ((invoice.status === "sent" || invoice.status === "partial") && invoice.dueDate < today) return "overdue";
  return invoice.status;
}

/** Paid state comes from payments only: full payment is paid, some payment is partial, no payment is sent. */
function statusAfterPayment(total: number, paidAmount: number): InvoiceStatus {
  if (paidAmount >= total) return "paid";
  if (paidAmount > 0) return "partial";
  return "sent";
}

// ---------------------------------------------------------------- members

export class MemberService extends ServiceBase {
  list(): Promise<Member[]> {
    return this.storage.members.all();
  }

  search(query: string): Promise<Member[]> {
    return this.storage.members.search(query);
  }

  get(id: string): Promise<Member | undefined> {
    return this.storage.members.get(id);
  }

  async create(input: MemberInput): Promise<Member> {
    requireCan(this.actor, "member.create");
    const data = parseInput(memberInput, input);
    return this.db.transaction("rw", [this.db.members, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "member");
      if (seenId) {
        const existing = await this.storage.members.get(seenId);
        if (existing) return existing;
      }
      const now = this.now();
      const member: Member = { ...baseFields(this.actor, now), name: data.name, email: data.email, phone: data.phone, notes: data.notes, status: data.status };
      await this.storage.members.put(member);
      await this.recordKey(data.idempotencyKey, "member", member.id);
      await this.audit("member.create", "member", member.id, member.name);
      return member;
    });
  }

  async update(id: string, input: MemberPatch): Promise<Member> {
    requireCan(this.actor, "member.update");
    const data = parseInput(memberPatch, input);
    return this.db.transaction("rw", [this.db.members, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "member");
      if (seenId === id) {
        const existing = await this.storage.members.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.members.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `member ${id}` });
      const now = this.now();
      const updated: Member = { ...touched(current, now), name: data.name ?? current.name, email: data.email ?? current.email, phone: data.phone ?? current.phone, notes: data.notes ?? current.notes, status: data.status ?? current.status };
      await this.storage.members.put(updated);
      await this.recordKey(data.idempotencyKey, "member", id);
      await this.audit("member.update", "member", id, updated.name);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    requireCan(this.actor, "member.delete");
    const member = await this.storage.members.get(id);
    if (!member) throw new AppError("NOT_FOUND", { details: `member ${id}` });
    const [enrollments, invoices] = await Promise.all([this.storage.enrollments.listByMember(id), this.storage.invoices.listByMember(id)]);
    if (enrollments.length > 0 || invoices.length > 0) {
      throw new AppError("DELETE_BLOCKED", { details: "Member still has enrollments or invoices" });
    }
    await this.db.transaction("rw", [this.db.members, this.db.trash, this.db.auditLog], async () => {
      await this.storage.members.remove(id);
      await this.storage.trash.put(createTrashEntry("member", id, member.name, member, [], this.now()));
      await this.audit("member.trash", "member", id, member.name);
    });
  }
}

// ---------------------------------------------------------------- trainers

export class TrainerService extends ServiceBase {
  list(): Promise<Trainer[]> {
    return this.storage.trainers.all();
  }

  search(query: string): Promise<Trainer[]> {
    return this.storage.trainers.search(query);
  }

  get(id: string): Promise<Trainer | undefined> {
    return this.storage.trainers.get(id);
  }

  async create(input: TrainerInput): Promise<Trainer> {
    requireCan(this.actor, "trainer.create");
    const data = parseInput(trainerInput, input);
    return this.db.transaction("rw", [this.db.trainers, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "trainer");
      if (seenId) {
        const existing = await this.storage.trainers.get(seenId);
        if (existing) return existing;
      }
      const now = this.now();
      const trainer: Trainer = { ...baseFields(this.actor, now), name: data.name, email: data.email, phone: data.phone, subjects: dedupeSkills(data.subjects), ratePerSession: data.ratePerSession, status: data.status };
      await this.storage.trainers.put(trainer);
      await this.recordKey(data.idempotencyKey, "trainer", trainer.id);
      await this.audit("trainer.create", "trainer", trainer.id, trainer.name);
      return trainer;
    });
  }

  async update(id: string, input: TrainerPatch): Promise<Trainer> {
    requireCan(this.actor, "trainer.update");
    const data = parseInput(trainerPatch, input);
    return this.db.transaction("rw", [this.db.trainers, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "trainer");
      if (seenId === id) {
        const existing = await this.storage.trainers.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.trainers.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `trainer ${id}` });
      const now = this.now();
      const updated: Trainer = {
        ...touched(current, now),
        name: data.name ?? current.name,
        email: data.email ?? current.email,
        phone: data.phone ?? current.phone,
        subjects: data.subjects ? dedupeSkills(data.subjects) : current.subjects,
        ratePerSession: data.ratePerSession ?? current.ratePerSession,
        status: data.status ?? current.status,
      };
      await this.storage.trainers.put(updated);
      await this.recordKey(data.idempotencyKey, "trainer", id);
      await this.audit("trainer.update", "trainer", id, updated.name);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    requireCan(this.actor, "trainer.delete");
    const trainer = await this.storage.trainers.get(id);
    if (!trainer) throw new AppError("NOT_FOUND", { details: `trainer ${id}` });
    // A trainer owns no course any more, so only sessions they taught and pay runs block the delete.
    const sessions = await this.storage.sessions.all();
    const runs = await this.storage.payrollRuns.listByTrainer(id);
    if (sessions.some((s) => s.trainerId === id) || runs.length > 0) {
      throw new AppError("DELETE_BLOCKED", { details: "Trainer still has sessions or pay runs" });
    }
    await this.db.transaction("rw", [this.db.trainers, this.db.trash, this.db.auditLog], async () => {
      await this.storage.trainers.remove(id);
      await this.storage.trash.put(createTrashEntry("trainer", id, trainer.name, trainer, [], this.now()));
      await this.audit("trainer.trash", "trainer", id, trainer.name);
    });
  }
}

// ---------------------------------------------------------------- courses + enrollments

/** Weekdays sorted ascending with duplicates removed, so [5, 1, 1] stores as [1, 5]. */
function normalizeWeekdays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

export class CourseService extends ServiceBase {
  list(): Promise<Course[]> {
    return this.storage.courses.all();
  }

  async search(query: string): Promise<Course[]> {
    const q = query.trim();
    const byTitle = await this.storage.courses.search(q);
    byTitle.sort((a, b) => a.title.localeCompare(b.title));
    return byTitle;
  }

  get(id: string): Promise<Course | undefined> {
    return this.storage.courses.get(id);
  }

  async create(input: CourseInput): Promise<Course> {
    requireCan(this.actor, "course.create");
    const data = parseInput(courseInput, input);
    return this.db.transaction("rw", [this.db.courses, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "course");
      if (seenId) {
        const existing = await this.storage.courses.get(seenId);
        if (existing) return existing;
      }
      const now = this.now();
      const course: Course = { ...baseFields(this.actor, now), title: data.title, description: data.description, level: data.level, price: data.price, capacity: data.capacity, requiredSkills: dedupeSkills(data.requiredSkills), scheduleWeekdays: normalizeWeekdays(data.scheduleWeekdays), status: data.status };
      await this.storage.courses.put(course);
      await this.recordKey(data.idempotencyKey, "course", course.id);
      await this.audit("course.create", "course", course.id, course.title);
      return course;
    });
  }

  async update(id: string, input: CoursePatch): Promise<Course> {
    requireCan(this.actor, "course.update");
    const data = parseInput(coursePatch, input);
    return this.db.transaction("rw", [this.db.courses, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "course");
      if (seenId === id) {
        const existing = await this.storage.courses.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.courses.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `course ${id}` });
      const now = this.now();
      const updated: Course = {
        ...touched(current, now),
        title: data.title ?? current.title,
        description: data.description ?? current.description,
        level: data.level ?? current.level,
        price: data.price ?? current.price,
        capacity: data.capacity ?? current.capacity,
        requiredSkills: data.requiredSkills ? dedupeSkills(data.requiredSkills) : current.requiredSkills ?? [],
        scheduleWeekdays: data.scheduleWeekdays ? normalizeWeekdays(data.scheduleWeekdays) : current.scheduleWeekdays,
        status: data.status ?? current.status,
      };
      await this.storage.courses.put(updated);
      await this.recordKey(data.idempotencyKey, "course", id);
      await this.audit("course.update", "course", id, updated.title);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    requireCan(this.actor, "course.delete");
    const course = await this.storage.courses.get(id);
    if (!course) throw new AppError("NOT_FOUND", { details: `course ${id}` });
    const [enrollments, sessions] = await Promise.all([this.storage.enrollments.listByCourse(id), this.storage.sessions.listByCourse(id)]);
    if (enrollments.length > 0 || sessions.length > 0) {
      throw new AppError("DELETE_BLOCKED", { details: "Course still has enrollments or sessions" });
    }
    await this.db.transaction("rw", [this.db.courses, this.db.trash, this.db.auditLog], async () => {
      await this.storage.courses.remove(id);
      await this.storage.trash.put(createTrashEntry("course", id, course.title, course, [], this.now()));
      await this.audit("course.trash", "course", id, course.title);
    });
  }

  // ---------------------------------------------------------- enrollments

  async enroll(input: EnrollmentInput): Promise<Enrollment> {
    requireCan(this.actor, "enrollment.create");
    const data = parseInput(enrollmentInput, input);
    const [member, course] = await Promise.all([this.storage.members.get(data.memberId), this.storage.courses.get(data.courseId)]);
    if (!member) throw new ValidationError("memberId", "member does not exist", "invalid");
    if (!course) throw new ValidationError("courseId", "course does not exist", "invalid");
    assertDateOnSchedule("startDate", data.startDate, course);
    return this.db.transaction("rw", [this.db.enrollments, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "enrollment");
      if (seenId) {
        const existing = await this.storage.enrollments.get(seenId);
        if (existing) return existing;
      }
      // Checked inside the transaction: a second enroll racing the first sees it once it lands.
      const active = await this.storage.enrollments.findActive(data.memberId, data.courseId);
      if (active && data.status === "active") throw new ValidationError("memberId", "member is already enrolled in this course", "invalid");
      const now = this.now();
      const enrollment: Enrollment = { ...baseFields(this.actor, now), memberId: data.memberId, courseId: data.courseId, startDate: data.startDate, endDate: data.endDate, status: data.status };
      await this.storage.enrollments.put(enrollment);
      await this.recordKey(data.idempotencyKey, "enrollment", enrollment.id);
      await this.audit("enrollment.create", "enrollment", enrollment.id, `${member.name} → ${course.title}`);
      return enrollment;
    });
  }

  async updateEnrollment(id: string, input: EnrollmentPatch): Promise<Enrollment> {
    requireCan(this.actor, "enrollment.update");
    const data = parseInput(enrollmentPatch, input);
    // Checked before the transaction, like enroll does: the courses table is
    // outside this transaction's scope, so it cannot be read inside it.
    // Only a move to a new start date or course is checked: an untouched
    // enrollment keeps its date even when it predates the weekly slot.
    if (data.startDate !== undefined || data.courseId !== undefined) {
      const current = await this.storage.enrollments.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `enrollment ${id}` });
      const course = await this.storage.courses.get(data.courseId ?? current.courseId);
      if (course) assertDateOnSchedule("startDate", data.startDate ?? current.startDate, course);
    }
    return this.db.transaction("rw", [this.db.enrollments, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "enrollment");
      if (seenId === id) {
        const existing = await this.storage.enrollments.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.enrollments.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `enrollment ${id}` });
      const now = this.now();
      const updated: Enrollment = {
        ...touched(current, now),
        memberId: data.memberId ?? current.memberId,
        courseId: data.courseId ?? current.courseId,
        startDate: data.startDate ?? current.startDate,
        endDate: data.endDate !== undefined ? data.endDate : current.endDate,
        status: data.status ?? current.status,
      };
      await this.storage.enrollments.put(updated);
      await this.recordKey(data.idempotencyKey, "enrollment", id);
      await this.audit("enrollment.update", "enrollment", id, updated.status);
      return updated;
    });
  }

  async removeEnrollment(id: string): Promise<void> {
    requireCan(this.actor, "enrollment.delete");
    const enrollment = await this.storage.enrollments.get(id);
    if (!enrollment) throw new AppError("NOT_FOUND", { details: `enrollment ${id}` });
    const invoices = await this.storage.invoices.all();
    if (invoices.some((i) => i.enrollmentId === id)) {
      throw new AppError("DELETE_BLOCKED", { details: "Enrollment still has invoices" });
    }
    const [member, course] = await Promise.all([this.storage.members.get(enrollment.memberId), this.storage.courses.get(enrollment.courseId)]);
    const label = `${member?.name ?? enrollment.memberId} → ${course?.title ?? enrollment.courseId}`;
    await this.db.transaction("rw", [this.db.enrollments, this.db.trash, this.db.auditLog], async () => {
      await this.storage.enrollments.remove(id);
      await this.storage.trash.put(createTrashEntry("enrollment", id, label, enrollment, [], this.now()));
      await this.audit("enrollment.trash", "enrollment", id, label);
    });
  }

  listEnrollmentsByMember(memberId: string): Promise<Enrollment[]> {
    return this.storage.enrollments.listByMember(memberId);
  }

  listEnrollmentsByCourse(courseId: string): Promise<Enrollment[]> {
    return this.storage.enrollments.listByCourse(courseId);
  }
}

// ---------------------------------------------------------------- sessions + attendance

/** One row of the attendance dashboard: one member in one course, with every attendance mark for that pair. */
export interface AttendanceDashboardRow {
  memberId: string;
  memberName: string;
  courseId: string;
  courseTitle: string;
  trainerId: string;
  trainerName: string;
  /** Attendance marks for this pair. */
  sessions: number;
  present: number;
  absent: number;
  late: number;
  /** Present + late as a share of all marks, 0-100. */
  rate: number;
  /** Hours attended in this course, from the time ranges of present and late sessions. */
  attendedHours: number;
}

export interface AttendanceDashboardFilter {
  trainerId?: string;
  memberId?: string;
  courseId?: string;
}

export interface AttendanceDashboardSummary {
  rows: AttendanceDashboardRow[];
  totalSessions: number;
  totalAttendedHours: number;
  overallRate: number;
}

/** One row of the trainer dashboard: one trainer in one course, with every session they taught there. */
export interface TrainerDashboardRow {
  trainerId: string;
  trainerName: string;
  courseId: string;
  courseTitle: string;
  /** Sessions of this trainer in this course. */
  sessions: number;
  /** Sessions where the trainer was marked present. */
  present: number;
  /** Sessions where the trainer was marked absent. */
  absent: number;
  /** Present as a share of all sessions, 0-100. */
  rate: number;
  /** Hours taught in this course, from the time ranges of present sessions. */
  hoursTaught: number;
}

export interface TrainerDashboardFilter {
  trainerId?: string;
  courseId?: string;
}

export interface TrainerDashboardSummary {
  rows: TrainerDashboardRow[];
  totalSessions: number;
  totalHoursTaught: number;
  overallRate: number;
}

export class AttendanceService extends ServiceBase {
  listSessionsByCourse(courseId: string): Promise<Session[]> {
    return this.storage.sessions.listByCourse(courseId);
  }

  getSession(id: string): Promise<Session | undefined> {
    return this.storage.sessions.get(id);
  }

  async createSession(input: SessionInput): Promise<Session> {
    requireCan(this.actor, "session.create");
    const data = parseInput(sessionInput, input);
    const [course, trainer] = await Promise.all([this.storage.courses.get(data.courseId), this.storage.trainers.get(data.trainerId)]);
    if (!course) throw new ValidationError("courseId", "course does not exist", "invalid");
    if (!trainer) throw new ValidationError("trainerId", "trainer does not exist", "invalid");
    assertDateOnSchedule("date", data.date, course);
    return this.db.transaction("rw", [this.db.sessions, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "session");
      if (seenId) {
        const existing = await this.storage.sessions.get(seenId);
        if (existing) return existing;
      }
      // Checked inside the transaction: a second create racing the first sees it once it lands.
      const duplicate = await this.storage.sessions.findByCourseAndDate(data.courseId, data.date);
      if (duplicate) throw new ValidationError("date", "a session already exists for this course on this date", "invalid");
      const now = this.now();
      const session: Session = { ...baseFields(this.actor, now), courseId: data.courseId, date: data.date, topic: data.topic, trainerId: data.trainerId, trainerPresent: data.trainerPresent, startTime: data.startTime, endTime: data.endTime };
      await this.storage.sessions.put(session);
      await this.recordKey(data.idempotencyKey, "session", session.id);
      await this.audit("session.create", "session", session.id, `${course.title} · ${session.date}`);
      return session;
    });
  }

  async setTrainerPresent(sessionId: string, present: boolean, idempotencyKey: string): Promise<Session> {
    requireCan(this.actor, "session.update");
    return this.db.transaction("rw", [this.db.sessions, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(idempotencyKey, "session");
      if (seenId === sessionId) {
        const existing = await this.storage.sessions.get(sessionId);
        if (existing) return existing;
      }
      const current = await this.storage.sessions.get(sessionId);
      if (!current) throw new AppError("NOT_FOUND", { details: `session ${sessionId}` });
      const updated: Session = { ...touched(current, this.now()), trainerPresent: present };
      await this.storage.sessions.put(updated);
      await this.recordKey(idempotencyKey, "session", sessionId);
      await this.audit("session.update", "session", sessionId, present ? "trainer present" : "trainer absent");
      return updated;
    });
  }

  async removeSession(id: string): Promise<void> {
    requireCan(this.actor, "session.delete");
    const session = await this.storage.sessions.get(id);
    if (!session) throw new AppError("NOT_FOUND", { details: `session ${id}` });
    const course = await this.storage.courses.get(session.courseId);
    const label = `${course?.title ?? session.courseId} · ${session.date}`;
    await this.db.transaction("rw", [this.db.sessions, this.db.attendance, this.db.trash, this.db.auditLog], async () => {
      const rows = await this.storage.attendance.listBySession(id);
      for (const r of rows) await this.storage.attendance.remove(r.id);
      await this.storage.sessions.remove(id);
      await this.storage.trash.put(createTrashEntry("session", id, label, session, rows, this.now()));
      await this.audit("session.trash", "session", id, label);
    });
  }

  /** Marks attendance for one session. Every member listed must hold an active enrollment in the session's course. */
  async mark(sessionId: string, marks: Array<{ memberId: string; status: AttendanceStatus }>, idempotencyKey: string): Promise<Attendance[]> {
    requireCan(this.actor, "attendance.mark");
    if (!idempotencyKey) throw new ValidationError("idempotencyKey", "idempotency key is required", "required");
    const session = await this.storage.sessions.get(sessionId);
    if (!session) throw new AppError("NOT_FOUND", { details: `session ${sessionId}` });
    const enrolled = await this.storage.enrollments.listActiveByCourse(session.courseId);
    const enrolledIds = new Set(enrolled.map((e) => e.memberId));
    for (const m of marks) {
      const data = parseInput(attendanceInput, { sessionId, memberId: m.memberId, status: m.status, idempotencyKey });
      if (!enrolledIds.has(m.memberId)) throw new ValidationError("memberId", "member is not enrolled in this course", "invalid");
    }
    return this.db.transaction("rw", [this.db.attendance, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(idempotencyKey, "attendance-batch");
      if (seenId) {
        const existing = await this.storage.attendance.listBySession(sessionId);
        if (existing.length > 0) return existing;
      }
      const now = this.now();
      const out: Attendance[] = [];
      for (const m of marks) {
        const current = await this.storage.attendance.find(sessionId, m.memberId);
        const record: Attendance = current
          ? { ...touched(current, now), status: m.status }
          : { ...baseFields(this.actor, now), sessionId, memberId: m.memberId, status: m.status };
        await this.storage.attendance.put(record);
        out.push(record);
      }
      await this.recordKey(idempotencyKey, "attendance-batch", sessionId);
      await this.audit("attendance.mark", "attendance", sessionId, `${out.length} members marked`);
      return out;
    });
  }

  listAttendance(sessionId: string): Promise<Attendance[]> {
    return this.storage.attendance.listBySession(sessionId);
  }

  /** Total hours a member attended in one course: present or late sessions only, durations derived from each session's time range. Sessions without times add nothing. */
  async attendedHours(memberId: string, courseId: string): Promise<number> {
    const sessions = await this.storage.sessions.listByCourse(courseId);
    let total = 0;
    for (const session of sessions) {
      const rows = await this.storage.attendance.listBySession(session.id);
      const mark = rows.find((r) => r.memberId === memberId);
      if (!mark || (mark.status !== "present" && mark.status !== "late")) continue;
      const hours = sessionDurationHours(session);
      if (hours !== null) total = Math.round((total + hours) * 100) / 100;
    }
    return total;
  }

  async dashboardSummary(filter: AttendanceDashboardFilter = {}): Promise<AttendanceDashboardSummary> {
    const [sessions, attendance, members, courses, trainers] = await Promise.all([
      this.storage.sessions.all(),
      this.storage.attendance.all(),
      this.storage.members.all(),
      this.storage.courses.all(),
      this.storage.trainers.all(),
    ]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const trainerById = new Map(trainers.map((t) => [t.id, t]));
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    // A session counts only when it passes the session-level filters.
    const visibleSessions = new Set(
      sessions
        .filter((s) => (filter.trainerId ? s.trainerId === filter.trainerId : true))
        .filter((s) => (filter.courseId ? s.courseId === filter.courseId : true))
        .map((s) => s.id),
    );
    const byPair = new Map<string, AttendanceDashboardRow>();
    let totalSessions = 0;
    let totalAttended = 0;
    let totalAttendedHours = 0;
    for (const row of attendance) {
      if (!visibleSessions.has(row.sessionId)) continue;
      if (filter.memberId && row.memberId !== filter.memberId) continue;
      const session = sessionById.get(row.sessionId);
      if (!session) continue;
      const key = `${row.memberId}|${session.courseId}`;
      let pair = byPair.get(key);
      if (!pair) {
        pair = {
          memberId: row.memberId,
          memberName: memberById.get(row.memberId)?.name ?? "",
          courseId: session.courseId,
          courseTitle: courseById.get(session.courseId)?.title ?? "",
          trainerId: session.trainerId,
          trainerName: trainerById.get(session.trainerId)?.name ?? "",
          sessions: 0,
          present: 0,
          absent: 0,
          late: 0,
          rate: 0,
          attendedHours: 0,
        };
        byPair.set(key, pair);
      }
      pair.sessions += 1;
      totalSessions += 1;
      if (row.status === "present") pair.present += 1;
      else if (row.status === "absent") pair.absent += 1;
      else pair.late += 1;
      if (row.status === "present" || row.status === "late") {
        totalAttended += 1;
        const hours = sessionDurationHours(session);
        if (hours !== null) {
          pair.attendedHours = Math.round((pair.attendedHours + hours) * 100) / 100;
          totalAttendedHours = Math.round((totalAttendedHours + hours) * 100) / 100;
        }
      }
    }
    const rows = [...byPair.values()].map((r) => ({
      ...r,
      rate: r.sessions === 0 ? 0 : Math.round(((r.present + r.late) / r.sessions) * 100),
    }));
    rows.sort((a, b) => a.memberName.localeCompare(b.memberName) || a.courseTitle.localeCompare(b.courseTitle));
    return {
      rows,
      totalSessions,
      totalAttendedHours,
      overallRate: totalSessions === 0 ? 0 : Math.round((totalAttended / totalSessions) * 100),
    };
  }

  /** Sessions in a date range, for the pay-run review. */
  listSessionsInRange(start: string, end: string): Promise<Session[]> {
    return this.storage.sessions.listInRange(start, end);
  }

  async trainerDashboardSummary(filter: TrainerDashboardFilter = {}): Promise<TrainerDashboardSummary> {
    const [sessions, courses, trainers] = await Promise.all([
      this.storage.sessions.all(),
      this.storage.courses.all(),
      this.storage.trainers.all(),
    ]);
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const trainerById = new Map(trainers.map((t) => [t.id, t]));
    const byPair = new Map<string, TrainerDashboardRow>();
    let totalSessions = 0;
    let totalPresent = 0;
    let totalHoursTaught = 0;
    for (const session of sessions) {
      if (filter.trainerId && session.trainerId !== filter.trainerId) continue;
      if (filter.courseId && session.courseId !== filter.courseId) continue;
      const key = `${session.trainerId}|${session.courseId}`;
      let pair = byPair.get(key);
      if (!pair) {
        pair = {
          trainerId: session.trainerId,
          trainerName: trainerById.get(session.trainerId)?.name ?? "",
          courseId: session.courseId,
          courseTitle: courseById.get(session.courseId)?.title ?? "",
          sessions: 0,
          present: 0,
          absent: 0,
          rate: 0,
          hoursTaught: 0,
        };
        byPair.set(key, pair);
      }
      pair.sessions += 1;
      totalSessions += 1;
      if (session.trainerPresent) {
        pair.present += 1;
        totalPresent += 1;
        const hours = sessionDurationHours(session);
        if (hours !== null) {
          pair.hoursTaught = Math.round((pair.hoursTaught + hours) * 100) / 100;
          totalHoursTaught = Math.round((totalHoursTaught + hours) * 100) / 100;
        }
      } else {
        pair.absent += 1;
      }
    }
    const rows = [...byPair.values()].map((r) => ({
      ...r,
      rate: r.sessions === 0 ? 0 : Math.round((r.present / r.sessions) * 100),
    }));
    rows.sort((a, b) => a.trainerName.localeCompare(b.trainerName) || a.courseTitle.localeCompare(b.courseTitle));
    return {
      rows,
      totalSessions,
      totalHoursTaught,
      overallRate: totalSessions === 0 ? 0 : Math.round((totalPresent / totalSessions) * 100),
    };
  }
}

// ---------------------------------------------------------------- invoices + payments

export class InvoiceService extends ServiceBase {
  list(): Promise<Invoice[]> {
    return this.storage.invoices.all();
  }

  async search(query: string): Promise<Invoice[]> {
    const q = query.trim();
    const byNumber = await this.storage.invoices.search(q);
    if (!q) return byNumber;
    // The search bar promises "number or member": match members by name, then their invoices.
    const members = await this.storage.members.search(q);
    const seen = new Set(byNumber.map((i) => i.id));
    const merged = [...byNumber];
    for (const m of members) {
      for (const invoice of await this.storage.invoices.listByMember(m.id)) {
        if (!seen.has(invoice.id)) {
          seen.add(invoice.id);
          merged.push(invoice);
        }
      }
    }
    merged.sort((a, b) => b.number.localeCompare(a.number));
    return merged;
  }

  get(id: string): Promise<Invoice | undefined> {
    return this.storage.invoices.get(id);
  }

  listByMember(memberId: string): Promise<Invoice[]> {
    return this.storage.invoices.listByMember(memberId);
  }

  async create(input: InvoiceInput): Promise<Invoice> {
    requireCan(this.actor, "invoice.create");
    const data = parseInput(invoiceInput, input);
    const member = await this.storage.members.get(data.memberId);
    if (!member) throw new ValidationError("memberId", "member does not exist", "invalid");
    if (data.enrollmentId) {
      const enrollment = await this.storage.enrollments.get(data.enrollmentId);
      if (!enrollment) throw new ValidationError("enrollmentId", "enrollment does not exist", "invalid");
      if (enrollment.memberId !== data.memberId) throw new ValidationError("enrollmentId", "enrollment belongs to a different member", "invalid");
    }
    return this.db.transaction("rw", [this.db.invoices, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "invoice");
      if (seenId) {
        const existing = await this.storage.invoices.get(seenId);
        if (existing) return existing;
      }
      const now = this.now();
      const created = new Date(now);
      const pad = (n: number) => String(n).padStart(2, "0");
      const prefix = `INV-${created.getFullYear()}${pad(created.getMonth() + 1)}${pad(created.getDate())}-`;
      const numbers = await this.storage.invoices.numbersWithPrefix(prefix);
      const total = data.lineItems.reduce((sum, item) => sum + item.amount, 0);
      const invoice: Invoice = {
        ...baseFields(this.actor, now),
        number: nextInvoiceNumber(numbers, new Date(now)),
        memberId: data.memberId,
        enrollmentId: data.enrollmentId,
        lineItems: data.lineItems.map((item) => ({ ...item })),
        total,
        paidAmount: 0,
        dueDate: data.dueDate,
        status: data.status,
        paymentMethod: data.paymentMethod,
        paymentDetails: data.paymentDetails,
      };
      await this.storage.invoices.put(invoice);
      await this.recordKey(data.idempotencyKey, "invoice", invoice.id);
      await this.audit("invoice.create", "invoice", invoice.id, `${invoice.number} · ${member.name}`);
      return invoice;
    });
  }

  async update(id: string, input: InvoicePatch): Promise<Invoice> {
    requireCan(this.actor, "invoice.update");
    const data = parseInput(invoicePatch, input);
    if (data.status && data.status !== "draft" && data.status !== "sent") {
      throw new ValidationError("status", "only draft or sent can be set here; paid state comes from payments", "invalid");
    }
    return this.db.transaction("rw", [this.db.invoices, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "invoice");
      if (seenId === id) {
        const existing = await this.storage.invoices.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.invoices.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `invoice ${id}` });
      if (data.status && (current.status === "paid" || current.status === "partial")) {
        throw new ValidationError("status", "an invoice with payments keeps its status", "invalid");
      }
      // A legacy row without payment fields reads as cash with no details, so
      // saving it here writes those defaults back instead of keeping blanks.
      const updated: Invoice = { ...touched(current, this.now()), dueDate: data.dueDate ?? current.dueDate, status: data.status ?? current.status, paymentMethod: data.paymentMethod ?? paymentMethodOf(current), paymentDetails: data.paymentDetails ?? paymentDetailsOf(current) };
      await this.storage.invoices.put(updated);
      await this.recordKey(data.idempotencyKey, "invoice", id);
      await this.audit("invoice.update", "invoice", id, updated.number);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    requireCan(this.actor, "invoice.delete");
    await this.db.transaction("rw", [this.db.invoices, this.db.payments, this.db.trash, this.db.auditLog], async () => {
      const invoice = await this.storage.invoices.get(id);
      if (!invoice) throw new AppError("NOT_FOUND", { details: `invoice ${id}` });
      const payments = await this.storage.payments.listByInvoice(id);
      for (const payment of payments) await this.storage.payments.remove(payment.id);
      await this.storage.invoices.remove(id);
      // Attachments stay keyed by invoice id, so restoring the invoice
      // leaves them working; they are only deleted with a permanent delete.
      await this.storage.trash.put(createTrashEntry("invoice", id, invoice.number, invoice, payments, this.now()));
      await this.audit("invoice.trash", "invoice", id, `${invoice.number}; ${payments.length} payments deleted`);
    });
  }

  /** Records a payment and re-derives the invoice paid total and status in the same transaction. */
  async recordPayment(input: PaymentInput): Promise<Payment> {
    requireCan(this.actor, "invoice.pay");
    const data = parseInput(paymentInput, input);
    return this.db.transaction("rw", [this.db.invoices, this.db.payments, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "payment");
      if (seenId) {
        const existing = await this.storage.payments.get(seenId);
        if (existing) return existing;
      }
      const invoice = await this.storage.invoices.get(data.invoiceId);
      if (!invoice) throw new AppError("NOT_FOUND", { details: `invoice ${data.invoiceId}` });
      if (invoice.status !== "sent" && invoice.status !== "partial") {
        throw new ValidationError("invoiceId", "only a sent invoice can take payments", "invalid");
      }
      const remaining = invoice.total - invoice.paidAmount;
      if (data.amount > remaining) throw new ValidationError("amount", "payment is more than the amount left", "invalid");
      const now = this.now();
      const payment: Payment = { ...baseFields(this.actor, now), invoiceId: data.invoiceId, amount: data.amount, at: now, method: data.method };
      await this.storage.payments.put(payment);
      const paidAmount = invoice.paidAmount + data.amount;
      // The recorded payment decides how the invoice is paid from now on; the
      // details stay as the user set them and are never invented here.
      const updated: Invoice = { ...touched(invoice, now), paidAmount, status: statusAfterPayment(invoice.total, paidAmount), paymentMethod: data.method };
      await this.storage.invoices.put(updated);
      await this.recordKey(data.idempotencyKey, "payment", payment.id);
      await this.audit("invoice.pay", "invoice", invoice.id, `${invoice.number} · +${data.amount}`);
      return payment;
    });
  }

  async removePayment(id: string): Promise<void> {
    requireCan(this.actor, "invoice.pay");
    const payment = await this.storage.payments.get(id);
    if (!payment) throw new AppError("NOT_FOUND", { details: `payment ${id}` });
    const invoice = await this.storage.invoices.get(payment.invoiceId);
    const label = `${invoice?.number ?? payment.invoiceId} · ${payment.amount}`;
    await this.db.transaction("rw", [this.db.invoices, this.db.payments, this.db.trash, this.db.auditLog], async () => {
      const current = await this.storage.invoices.get(payment.invoiceId);
      await this.storage.payments.remove(id);
      if (current) {
        const paidAmount = Math.max(0, current.paidAmount - payment.amount);
        const updated: Invoice = { ...touched(current, this.now()), paidAmount, status: statusAfterPayment(current.total, paidAmount) };
        await this.storage.invoices.put(updated);
      }
      await this.storage.trash.put(createTrashEntry("payment", id, label, payment, [], this.now()));
      await this.audit("payment.trash", "payment", id, `-${payment.amount}`);
    });
  }

  listPayments(invoiceId: string): Promise<Payment[]> {
    return this.storage.payments.listByInvoice(invoiceId);
  }
}

// ---------------------------------------------------------------- payroll

export class PayrollService extends ServiceBase {
  list(): Promise<PayrollRun[]> {
    return this.storage.payrollRuns.all();
  }

  get(id: string): Promise<PayrollRun | undefined> {
    return this.storage.payrollRuns.get(id);
  }

  listByTrainer(trainerId: string): Promise<PayrollRun[]> {
    return this.storage.payrollRuns.listByTrainer(trainerId);
  }

  /**
   * Builds a pay run from the trainer's attended sessions in the period: every session
   * in range where the trainer was marked present counts once, at the trainer's rate.
   * One run per trainer per period: generating again refreshes a draft run from the
   * current attendance, so a session later corrected to absent stops being paid.
   * A paid run never changes.
   */
  async generate(input: PayrollInput): Promise<PayrollRun> {
    requireCan(this.actor, "payroll.generate");
    const data = parseInput(payrollInput, input);
    if (data.periodEnd < data.periodStart) throw new ValidationError("periodEnd", "period end is before the start", "invalid");
    const trainer = await this.storage.trainers.get(data.trainerId);
    if (!trainer) throw new ValidationError("trainerId", "trainer does not exist", "invalid");
    return this.db.transaction("rw", [this.db.sessions, this.db.payrollRuns, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "payrollRun");
      if (seenId) {
        const found = await this.storage.payrollRuns.get(seenId);
        if (found) return found;
      }
      // Checked inside the transaction: a second generate racing the first sees the run once it lands.
      const existing = await this.storage.payrollRuns.findByTrainerAndPeriod(data.trainerId, data.periodStart);
      // A refresh always counts the run's own period, not the caller's range.
      const periodStart = existing?.periodStart ?? data.periodStart;
      const periodEnd = existing?.periodEnd ?? data.periodEnd;
      const sessions = await this.storage.sessions.listInRange(periodStart, periodEnd);
      const attended = sessions.filter((s) => s.trainerId === data.trainerId && s.trainerPresent);
      const now = this.now();
      if (existing) {
        // A paid run is a permanent record and never changes. A draft run is
        // refreshed from the current attendance, so a session corrected to
        // absent after the first generate stops being paid.
        if (existing.status === "paid") return existing;
        const refreshed: PayrollRun = {
          ...touched(existing, now),
          sessionIds: attended.map((s) => s.id),
          sessionCount: attended.length,
          ratePerSession: trainer.ratePerSession,
          total: attended.length * trainer.ratePerSession,
        };
        await this.storage.payrollRuns.put(refreshed);
        await this.recordKey(data.idempotencyKey, "payrollRun", refreshed.id);
        await this.audit("payroll.generate", "payrollRun", refreshed.id, `${trainer.name} · ${refreshed.sessionCount} sessions`);
        return refreshed;
      }
      const run: PayrollRun = {
        ...baseFields(this.actor, now),
        trainerId: data.trainerId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        sessionIds: attended.map((s) => s.id),
        sessionCount: attended.length,
        ratePerSession: trainer.ratePerSession,
        total: attended.length * trainer.ratePerSession,
        status: "draft",
        paidAt: null,
      };
      await this.storage.payrollRuns.put(run);
      await this.recordKey(data.idempotencyKey, "payrollRun", run.id);
      await this.audit("payroll.generate", "payrollRun", run.id, `${trainer.name} · ${run.sessionCount} sessions`);
      return run;
    });
  }

  async setStatus(id: string, input: PayrollPatch): Promise<PayrollRun> {
    requireCan(this.actor, "payroll.update");
    const data = parseInput(payrollPatch, input);
    return this.db.transaction("rw", [this.db.payrollRuns, this.db.writeKeys, this.db.auditLog], async () => {
      const seenId = await this.seenKey(data.idempotencyKey, "payrollRun");
      if (seenId === id) {
        const existing = await this.storage.payrollRuns.get(id);
        if (existing) return existing;
      }
      const current = await this.storage.payrollRuns.get(id);
      if (!current) throw new AppError("NOT_FOUND", { details: `payroll run ${id}` });
      if (current.status === "paid" && data.status === "draft") {
        throw new ValidationError("status", "a paid run cannot go back to draft", "invalid");
      }
      const now = this.now();
      const updated: PayrollRun = { ...touched(current, now), status: data.status, paidAt: data.status === "paid" ? now : current.paidAt };
      await this.storage.payrollRuns.put(updated);
      await this.recordKey(data.idempotencyKey, "payrollRun", id);
      await this.audit("payroll.update", "payrollRun", id, updated.status);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    requireCan(this.actor, "payroll.delete");
    const run = await this.storage.payrollRuns.get(id);
    if (!run) throw new AppError("NOT_FOUND", { details: `payroll run ${id}` });
    if (run.status === "paid") throw new AppError("DELETE_BLOCKED", { details: "A paid run is a permanent record" });
    const trainer = await this.storage.trainers.get(run.trainerId);
    const label = `${trainer?.name ?? run.trainerId} · ${run.periodStart}`;
    await this.db.transaction("rw", [this.db.payrollRuns, this.db.trash, this.db.auditLog], async () => {
      await this.storage.payrollRuns.remove(id);
      await this.storage.trash.put(createTrashEntry("payrollRun", id, label, run, [], this.now()));
      await this.audit("payrollRun.trash", "payrollRun", id, label);
    });
  }
}

// ---------------------------------------------------------------- currency

export interface CurrencySwitchResult {
  from: CurrencyCode;
  to: CurrencyCode;
  rate: number;
  switched: boolean;
  /** Switches left today after this call. */
  remaining: number;
}

/**
 * Currency switching: fetches the live rate first, then converts every stored
 * amount in one transaction, so a failure anywhere changes nothing. When no
 * amount-bearing record exists, the switch only changes the setting.
 */
export class CurrencyService extends ServiceBase {
  /** Switches left today, from 0 to 10. */
  async remainingSwitches(): Promise<number> {
    const { preferences } = await this.storage.preferences.load();
    const today = localDateString(new Date(this.now()));
    const used = preferences.currencySwitchDate === today ? preferences.currencySwitchCount : 0;
    return Math.max(0, DAILY_SWITCH_LIMIT - used);
  }

  /** True when any amount-bearing record exists: invoices, payments, courses, trainers or pay runs. */
  async hasConvertibleData(): Promise<boolean> {
    const [invoices, payments, courses, trainers, payrollRuns] = await Promise.all([
      this.storage.invoices.count(),
      this.storage.payments.count(),
      this.storage.courses.count(),
      this.storage.trainers.count(),
      this.storage.payrollRuns.count(),
    ]);
    return invoices + payments + courses + trainers + payrollRuns > 0;
  }

  async switchCurrency(to: CurrencyCode): Promise<CurrencySwitchResult> {
    requireCan(this.actor, "currency.switch");
    const { preferences } = await this.storage.preferences.load();
    const from = preferences.currency;
    const today = localDateString(new Date(this.now()));
    const used = preferences.currencySwitchDate === today ? preferences.currencySwitchCount : 0;
    const remaining = DAILY_SWITCH_LIMIT - used;
    if (to === from) return { from, to, rate: 1, switched: false, remaining };
    // With no amount-bearing records there is nothing to convert: the switch
    // only changes the setting, with no rate fetch and no daily-switch use.
    if (!(await this.hasConvertibleData())) {
      await this.db.transaction("rw", [this.db.settings, this.db.auditLog], async () => {
        await this.storage.settings.write(PREFERENCE_KEYS.currency, to);
        await this.audit("currency.switch", "currency", "currency", `${from} to ${to} with no conversion on ${today}`);
      });
      await this.storage.preferences.load();
      setCurrency(to);
      return { from, to, rate: 1, switched: true, remaining };
    }
    if (remaining <= 0) throw new AppError("CURRENCY_LIMIT_REACHED");
    // The rate is fetched before any write: a failed fetch changes nothing.
    const rate = await fetchRate(from, to);
    await this.db.transaction("rw", [this.db.invoices, this.db.payments, this.db.courses, this.db.trainers, this.db.payrollRuns, this.db.settings, this.db.auditLog], async () => {
      const payments = await this.storage.payments.all();
      const paidByInvoice = new Map<string, number>();
      for (const p of payments) {
        const converted: Payment = { ...p, amount: convert(p.amount, rate, to) };
        await this.storage.payments.put(converted);
        paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + converted.amount);
      }
      for (const inv of await this.storage.invoices.all()) {
        const lineItems = inv.lineItems.map((item) => ({ ...item, amount: convert(item.amount, rate, to) }));
        const total = lineItems.reduce((sum, item) => sum + item.amount, 0);
        const updated: Invoice = { ...touched(inv, this.now()), lineItems, total, paidAmount: paidByInvoice.get(inv.id) ?? 0 };
        await this.storage.invoices.put(updated);
      }
      for (const course of await this.storage.courses.all()) {
        await this.storage.courses.put({ ...touched(course, this.now()), price: convert(course.price, rate, to) });
      }
      for (const trainer of await this.storage.trainers.all()) {
        await this.storage.trainers.put({ ...touched(trainer, this.now()), ratePerSession: convert(trainer.ratePerSession, rate, to) });
      }
      for (const run of await this.storage.payrollRuns.all()) {
        const ratePerSession = convert(run.ratePerSession, rate, to);
        await this.storage.payrollRuns.put({ ...touched(run, this.now()), ratePerSession, total: run.sessionCount * ratePerSession });
      }
      await this.storage.settings.write(PREFERENCE_KEYS.currency, to);
      await this.storage.settings.write(PREFERENCE_KEYS.currencySwitchDate, today);
      await this.storage.settings.write(PREFERENCE_KEYS.currencySwitchCount, used + 1);
      await this.audit("currency.switch", "currency", "currency", `${from} to ${to} at rate ${rate} on ${today}`);
    });
    await this.storage.preferences.load();
    setCurrency(to);
    return { from, to, rate, switched: true, remaining: remaining - 1 };
  }
}

// ---------------------------------------------------------------- dashboard

export interface DashboardUpcomingSession {
  id: string;
  date: string;
  topic: string;
  courseTitle: string;
  trainerName: string;
}

export interface DashboardRecentInvoice {
  id: string;
  number: string;
  memberName: string;
  total: number;
  paidAmount: number;
  status: InvoiceDisplayStatus;
  dueDate: string;
}

export interface DashboardData {
  revenueCollectedThisMonth: number;
  outstandingTotal: number;
  overdueCount: number;
  overdueTotal: number;
  attendanceRate: number;
  attendanceCount: number;
  activeMembers: number;
  activeCourses: number;
  upcomingSessions: DashboardUpcomingSession[];
  recentInvoices: DashboardRecentInvoice[];
}

export class DashboardService extends ServiceBase {
  async get(today: string): Promise<DashboardData> {
    const { start, end } = monthRange(today);
    const startAt = new Date(`${start}T00:00:00`).getTime();
    const endAt = new Date(`${end}T23:59:59`).getTime();
    const [payments, invoices, attendance, members, courses, sessions] = await Promise.all([
      this.storage.payments.listInRange(startAt, endAt),
      this.storage.invoices.all(),
      this.storage.attendance.all(),
      this.storage.members.listByStatus("active"),
      this.storage.courses.listByStatus("active"),
      this.storage.sessions.all(),
    ]);
    const revenueCollectedThisMonth = payments.reduce((sum, p) => sum + p.amount, 0);
    let outstandingTotal = 0;
    let overdueCount = 0;
    let overdueTotal = 0;
    for (const inv of invoices) {
      const open = inv.total - inv.paidAmount;
      if (open <= 0) continue;
      outstandingTotal += open;
      if (effectiveInvoiceStatus(inv, today) === "overdue") {
        overdueCount++;
        overdueTotal += open;
      }
    }
    const attended = attendance.filter((a) => a.status === "present" || a.status === "late").length;
    const attendanceRate = attendance.length === 0 ? 0 : Math.round((attended / attendance.length) * 100);
    const upcoming = sessions
      .filter((s) => s.date >= today)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.topic.localeCompare(b.topic)))
      .slice(0, 5);
    const courseById = new Map(courses.map((c) => [c.id, c]));
    const allCourses = await this.storage.courses.all();
    const allCourseById = new Map(allCourses.map((c) => [c.id, c]));
    const trainers = await this.storage.trainers.all();
    const trainerById = new Map(trainers.map((t) => [t.id, t]));
    const upcomingSessions: DashboardUpcomingSession[] = upcoming.map((s) => ({
      id: s.id,
      date: s.date,
      topic: s.topic,
      courseTitle: (courseById.get(s.courseId) ?? allCourseById.get(s.courseId))?.title ?? "",
      trainerName: trainerById.get(s.trainerId)?.name ?? "",
    }));
    const memberById = new Map((await this.storage.members.all()).map((m) => [m.id, m]));
    const recentInvoices: DashboardRecentInvoice[] = [...invoices]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((inv) => ({
        id: inv.id,
        number: inv.number,
        memberName: memberById.get(inv.memberId)?.name ?? "",
        total: inv.total,
        paidAmount: inv.paidAmount,
        status: effectiveInvoiceStatus(inv, today),
        dueDate: inv.dueDate,
      }));
    return {
      revenueCollectedThisMonth,
      outstandingTotal,
      overdueCount,
      overdueTotal,
      attendanceRate,
      attendanceCount: attendance.length,
      activeMembers: members.length,
      activeCourses: courses.length,
      upcomingSessions,
      recentInvoices,
    };
  }
}

// ---------------------------------------------------------------- wiring

/** All services, built on the shared storage. The UI calls getServices(); tests build Services directly. */
export class Services {
  readonly members: MemberService;
  readonly trainers: TrainerService;
  readonly courses: CourseService;
  readonly attendance: AttendanceService;
  readonly invoices: InvoiceService;
  readonly payroll: PayrollService;
  readonly dashboard: DashboardService;
  readonly currency: CurrencyService;
  readonly attachments: AttachmentService;
  readonly trash: TrashService;

  constructor(
    readonly storage: StorageService,
    readonly actor: Actor = OWNER_ACTOR,
    clock: Clock = Date.now,
  ) {
    this.members = new MemberService(storage, actor, clock);
    this.trainers = new TrainerService(storage, actor, clock);
    this.courses = new CourseService(storage, actor, clock);
    this.attendance = new AttendanceService(storage, actor, clock);
    this.invoices = new InvoiceService(storage, actor, clock);
    this.payroll = new PayrollService(storage, actor, clock);
    this.dashboard = new DashboardService(storage, actor, clock);
    this.currency = new CurrencyService(storage, actor, clock);
    this.trash = new TrashService(storage, actor, clock);
    // The attachment audit entries use the same shape as the other services.
    // The write runs inside the attachment transaction, so the audit row
    // joins that transaction and is never written without its attachment.
    this.attachments = new AttachmentService(storage.db, async (action, entity, entityId, detail) => {
      await storage.audit.add({
        id: createId(),
        orgId: actor.orgId,
        actorId: actor.id,
        actorName: "Owner",
        action,
        entity,
        entityId,
        detail,
        at: clock(),
      });
    });
  }
}

let shared: Services | null = null;

/** Lazily creates the shared services in the browser (never during server prerender). */
export function getServices(): Services {
  shared ??= new Services(getStorage());
  return shared;
}

/** Forgets the shared services. Used by tests alongside resetStorage. */
export function resetServices(): void {
  shared = null;
}

/** Today in the user's local time, as YYYY-MM-DD. */
export function today(): string {
  return todayIso(new Date());
}
