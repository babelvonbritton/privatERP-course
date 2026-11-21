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
  /** Pay per taught session, in IDR. */
  ratePerSession: number;
  status: TrainerStatus;
}

export interface Course extends BaseRecord {
  title: string;
  description: string;
  level: string;
  /** Price per enrollment, in IDR. */
  price: number;
  capacity: number;
  trainerId: string;
  /** 0 = Sunday … 6 = Saturday, matching Date.getDay(). */
  scheduleWeekday: number;
  /** Start time as HH:MM. */
  scheduleTime: string;
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
  /** Sum of lineItems, in IDR. */
  total: number;
  /** Sum of payments, in IDR. Kept in step with the payments store. */
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
  /** sessionCount × ratePerSession, in IDR. */
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
