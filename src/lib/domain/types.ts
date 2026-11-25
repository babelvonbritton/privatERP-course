/** Domain types for Olaseena. Every record carries orgId, ownerId, timestamps and a revision so a future multi-user server can adopt the same rows without a migration. */

import type { Attachment } from "./attachments";
import type { TrashEntry } from "./trash";

/** The one organization this single-user install serves. A later server keeps the same field and adds more orgs. */
export const ORG_ID = "Olaseena";
/** The built-in owner account. A later server replaces this with real logged-in users. */
export const OWNER_ID = "owner";

/** Who performs an action. Today there is only the owner; the shape is what multi-user login will fill in later. */
export interface Actor {
  id: string;
  orgId: string;
  role: "owner";
}

export const OWNER_ACTOR: Actor = { id: OWNER_ID, orgId: ORG_ID, role: "owner" };

/** Currencies the app can store amounts in. All stored amounts are in the current currency. */
export const CURRENCIES = ["IDR", "EUR", "USD"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

/** True when the value is one of the supported currencies. */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Fields every stored record carries. */
export interface BaseRecord {
  id: string;
  orgId: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  /** Increments on every update; a future sync uses it to spot conflicts. */
  rev: number;
}

export const MEMBER_STATUSES = ["active", "inactive"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const TRAINER_STATUSES = ["active", "inactive"] as const;
export type TrainerStatus = (typeof TRAINER_STATUSES)[number];

export const COURSE_STATUSES = ["active", "archived"] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const ENROLLMENT_STATUSES = ["active", "completed", "cancelled"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = ["present", "absent", "late"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Stored invoice state. "overdue" is never stored: it is derived from dueDate vs today in the invoice service. */
export const INVOICE_STATUSES = ["draft", "sent", "paid", "partial"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceDisplayStatus = InvoiceStatus | "overdue";

export const PAYMENT_METHODS = ["cash", "transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYROLL_STATUSES = ["draft", "paid"] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export interface Member extends BaseRecord {
  name: string;
  email: string;
  phone: string;
  notes: string;
  status: MemberStatus;
}

export interface Trainer extends BaseRecord {
  name: string;
  email: string;
  phone: string;
  /** Subjects or skills this trainer teaches, one per entry. */
  subjects: string[];
  /** Pay per taught session, in the current currency. */
  ratePerSession: number;
  status: TrainerStatus;
}

export interface Course extends BaseRecord {
  title: string;
  description: string;
  level: string;
  /** Price per enrollment, in the current currency. */
  price: number;
  /** Skills a session trainer must have at least one of to teach this course. Empty means any trainer qualifies. */
  requiredSkills: string[];
  /** Weekdays the course meets, 0 = Sunday … 6 = Saturday, matching Date.getDay(). A course can meet on several days. */
  scheduleWeekdays: number[];
  status: CourseStatus;
}

export interface Enrollment extends BaseRecord {
  memberId: string;
  courseId: string;
  startDate: string;
  endDate: string | null;
  status: EnrollmentStatus;
}

export interface Session extends BaseRecord {
  courseId: string;
  /** Session date as YYYY-MM-DD. */
  date: string;
  topic: string;
  trainerId: string;
  trainerPresent: boolean;
  /** Start time as HH:MM. Empty on rows created before time ranges existed. */
  startTime: string;
  /** End time as HH:MM. Empty on rows created before time ranges existed. */
  endTime: string;
  /**
   * Optional cap on attending members (present or late) for this session.
   * Null or missing means no limit; sessions written before capacity existed
   * have no cap. Absent does not count toward the cap.
   */
  capacity?: number | null;
}

/** Minutes after midnight for an HH:MM string, or null when it is not a valid time. */
export function timeToMinutes(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Duration of a session in hours, derived from its time range. Null when either time is missing or the end is not after the start. */
export function sessionDurationHours(session: Pick<Session, "startTime" | "endTime">): number | null {
  const start = timeToMinutes(session.startTime);
  const end = timeToMinutes(session.endTime);
  if (start === null || end === null || end <= start) return null;
  return Math.round(((end - start) / 60) * 100) / 100;
}

/** A member counts toward the session cap only when present or late; absent does not. */
export function isAttendingStatus(status: AttendanceStatus): boolean {
  return status === "present" || status === "late";
}

/** A session's attendance cap, or null when it has none. Tolerates rows written before capacity existed. */
export function sessionCapacity(session: Pick<Session, "capacity"> & { capacity?: unknown }): number | null {
  const cap = session.capacity;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : null;
}

/**
 * Parses a session capacity field: blank means no limit, otherwise a whole
 * number of at least 1. Returns undefined when the text is not a usable cap,
 * so the caller can show the form error instead of guessing.
 */
export function parseSessionCapacity(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Weekdays a course meets, tolerating a legacy row that still carries a single scheduleWeekday. */
export function courseWeekdays(course: Pick<Course, "scheduleWeekdays"> & { scheduleWeekday?: unknown }): number[] {
  if (Array.isArray(course.scheduleWeekdays)) {
    return [...new Set(course.scheduleWeekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  }
  const legacy = course.scheduleWeekday;
  return typeof legacy === "number" && Number.isInteger(legacy) && legacy >= 0 && legacy <= 6 ? [legacy] : [];
}

/** Weekday (0 = Sunday … 6 = Saturday) of a YYYY-MM-DD date, or null when it is not a real calendar date. Built from parts, never parsed as a timestamp, so no timezone can shift the day. */
export function dateWeekday(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const built = new Date(year, month - 1, day);
  if (built.getFullYear() !== year || built.getMonth() !== month - 1 || built.getDate() !== day) return null;
  return built.getDay();
}

/** True when a date falls on one of the course's scheduled weekdays. A course with no scheduled days accepts any date, so legacy rows without a schedule stay usable. */
export function isDateOnSchedule(date: string, weekdays: number[]): boolean {
  if (weekdays.length === 0) return true;
  const day = dateWeekday(date);
  return day !== null && weekdays.includes(day);
}

/** One skill, trimmed. Empty strings stay empty so callers can drop them. */
export function normalizeSkill(skill: string): string {
  return skill.trim();
}

/** Skills deduplicated case-insensitively, keeping the first-seen casing and order. */
export function dedupeSkills(skills: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of skills) {
    const skill = normalizeSkill(raw);
    if (!skill) continue;
    const key = skill.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
}

/** Required skills of a course, tolerating a row written before required skills existed. */
export function courseRequiredSkills(course: { requiredSkills?: unknown }): string[] {
  return Array.isArray(course.requiredSkills) ? dedupeSkills(course.requiredSkills.filter((s): s is string => typeof s === "string")) : [];
}

/** Every skill already used anywhere: all trainer subjects plus all course required skills, deduplicated case-insensitively. */
export function allSkills(trainers: Pick<Trainer, "subjects">[], courses: Pick<Course, "requiredSkills">[]): string[] {
  const pool: string[] = [];
  for (const trainer of trainers) pool.push(...(Array.isArray(trainer.subjects) ? trainer.subjects : []));
  for (const course of courses) pool.push(...courseRequiredSkills(course));
  return dedupeSkills(pool);
}

/** How many of the course's required skills this trainer teaches, compared case-insensitively. */
export function trainerSkillMatchCount(trainer: Pick<Trainer, "subjects">, requiredSkills: string[]): number {
  const taught = new Set((Array.isArray(trainer.subjects) ? trainer.subjects : []).map((s) => s.trim().toLocaleLowerCase()));
  return dedupeSkills(requiredSkills).filter((skill) => taught.has(skill.toLocaleLowerCase())).length;
}

/** True when the trainer may teach a session of this course: at least one required skill, or any trainer when the course requires none. */
export function isTrainerQualified(trainer: Pick<Trainer, "subjects">, requiredSkills: string[]): boolean {
  const required = dedupeSkills(requiredSkills);
  return required.length === 0 || trainerSkillMatchCount(trainer, required) > 0;
}

export interface RankedTrainer<T extends Pick<Trainer, "subjects" | "name"> = Trainer> {
  trainer: T;
  /** Required skills this trainer matches. Zero when the course requires none. */
  matches: number;
}

/**
 * Trainers choosable for a session of a course, ranked by matching required
 * skills descending, ties alphabetical by name. Trainers matching none are
 * excluded when the course requires skills; with no required skills every
 * trainer is choosable in the order given.
 */
export function rankTrainersForCourse<T extends Pick<Trainer, "subjects" | "name">>(trainers: T[], requiredSkills: string[]): RankedTrainer<T>[] {
  const required = dedupeSkills(requiredSkills);
  const ranked = trainers.map((trainer) => ({ trainer, matches: required.length === 0 ? 0 : trainerSkillMatchCount(trainer, required) }));
  if (required.length === 0) return ranked;
  const kept = ranked.filter((r) => r.matches > 0);
  kept.sort((a, b) => b.matches - a.matches || a.trainer.name.localeCompare(b.trainer.name));
  return kept;
}

export interface Attendance extends BaseRecord {
  sessionId: string;
  memberId: string;
  status: AttendanceStatus;
}

export interface InvoiceLineItem {
  description: string;
  amount: number;
}

export interface Invoice extends BaseRecord {
  /** Allocated sequentially per day: INV-YYYYMMDD-###. */
  number: string;
  memberId: string;
  enrollmentId: string | null;
  lineItems: InvoiceLineItem[];
  /** Sum of lineItems, in the current currency. */
  total: number;
  /** Sum of payments, in the current currency. Kept in step with the payments store. */
  paidAmount: number;
  dueDate: string;
  status: InvoiceStatus;
  /** How the customer is asked to pay. */
  paymentMethod: PaymentMethod;
  /** Where the customer should pay, shown only for non-cash methods. */
  paymentDetails: string;
}

export interface Payment extends BaseRecord {
  invoiceId: string;
  amount: number;
  /** When the payment was recorded, as a millisecond timestamp. */
  at: number;
  method: PaymentMethod;
}

export interface PayrollRun extends BaseRecord {
  trainerId: string;
  periodStart: string;
  periodEnd: string;
  sessionIds: string[];
  sessionCount: number;
  ratePerSession: number;
  /** sessionCount × ratePerSession, in the current currency. */
  total: number;
  status: PayrollStatus;
  paidAt: number | null;
}

/** One append-only audit entry: who did what, to which record, and when. */
export interface AuditLogEntry {
  id: string;
  orgId: string;
  actorId: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
  at: number;
}

/** Idempotency record: a write key seen once, with the record it produced. A repeat presentation returns the same record instead of writing again. */
export interface WriteKey {
  key: string;
  entity: string;
  entityId: string;
  createdAt: number;
}

export interface SettingRecord {
  key: string;
  value: string | number | boolean | null;
}

/** Field length limits, enforced by the service layer before any write. */
export const LIMITS = {
  name: 80,
  email: 120,
  phone: 40,
  notes: 2000,
  subject: 60,
  subjects: 12,
  requiredSkills: 12,
  courseTitle: 120,
  description: 2000,
  level: 40,
  topic: 120,
  lineDescription: 120,
  lineItems: 20,
  paymentDetails: 200,
  detail: 500,
} as const;

/** Whole-database snapshot, the unit backup, restore and rollback move around. */
export interface BackupData {
  members: Member[];
  trainers: Trainer[];
  courses: Course[];
  enrollments: Enrollment[];
  sessions: Session[];
  attendance: Attendance[];
  invoices: Invoice[];
  payments: Payment[];
  payrollRuns: PayrollRun[];
  auditLog: AuditLogEntry[];
  writeKeys: WriteKey[];
  settings: SettingRecord[];
  /** Deleted records held in the trash, with their snapshots and related rows. */
  trash: TrashEntry[];
  /** Attachment metadata. The file bytes travel separately as ZIP entries; the IndexedDB store for these rows arrives later, so snapshots carry an empty list for now. */
  attachments: Attachment[];
}
