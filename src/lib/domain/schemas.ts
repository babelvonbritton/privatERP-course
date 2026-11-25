import { z } from "zod";
import { ValidationError } from "@/lib/storage/Guard";
import { getCurrency, hasCurrencyPrecision } from "@/lib/currency";
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
} from "./types";

/**
 * Input schemas for every write. These run at the service boundary, the same
 * schemas a future server API will enforce, so the UI layer is never trusted.
 */

const name = z.string().trim().min(1).max(LIMITS.name);
const email = z.string().trim().max(LIMITS.email).email().or(z.literal(""));
const phone = z.string().trim().max(LIMITS.phone);
const notes = z.string().max(LIMITS.notes);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const id = z.string().min(1).max(64);
const idemKey = z.string().min(1).max(128);
const money = (min: number, max: number) =>
  z.number().min(min).max(max).refine((value) => hasCurrencyPrecision(value, getCurrency()));

export const memberInput = z.object({
  name,
  email,
  phone,
  notes,
  status: z.enum(MEMBER_STATUSES),
  idempotencyKey: idemKey,
});
export type MemberInput = z.infer<typeof memberInput>;

export const memberPatch = memberInput.partial().omit({ idempotencyKey: true }).extend({ idempotencyKey: idemKey });
export type MemberPatch = z.infer<typeof memberPatch>;

export const trainerInput = z.object({
  name,
  email,
  phone,
  subjects: z.array(z.string().trim().min(1).max(LIMITS.subject)).max(LIMITS.subjects),
  ratePerSession: money(0, 100_000_000),
  status: z.enum(TRAINER_STATUSES),
  idempotencyKey: idemKey,
});
export type TrainerInput = z.infer<typeof trainerInput>;

export const trainerPatch = trainerInput.partial().omit({ idempotencyKey: true }).extend({ idempotencyKey: idemKey });
export type TrainerPatch = z.infer<typeof trainerPatch>;

export const courseInput = z.object({
  title: z.string().trim().min(1).max(LIMITS.courseTitle),
  description: z.string().max(LIMITS.description),
  level: z.string().trim().min(1).max(LIMITS.level),
  price: money(0, 1_000_000_000),
  requiredSkills: z.array(z.string().trim().min(1).max(LIMITS.subject)).max(LIMITS.requiredSkills),
  scheduleWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  status: z.enum(COURSE_STATUSES),
  idempotencyKey: idemKey,
});
export type CourseInput = z.infer<typeof courseInput>;

export const coursePatch = courseInput.partial().omit({ idempotencyKey: true }).extend({ idempotencyKey: idemKey });
export type CoursePatch = z.infer<typeof coursePatch>;

export const enrollmentInput = z.object({
  memberId: id,
  courseId: id,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  status: z.enum(ENROLLMENT_STATUSES),
  idempotencyKey: idemKey,
});
export type EnrollmentInput = z.infer<typeof enrollmentInput>;

export const enrollmentPatch = enrollmentInput.partial().omit({ idempotencyKey: true }).extend({ idempotencyKey: idemKey });
export type EnrollmentPatch = z.infer<typeof enrollmentPatch>;

export const sessionInput = z
  .object({
    courseId: id,
    date: isoDate,
    topic: z.string().trim().min(1).max(LIMITS.topic),
    trainerId: id,
    trainerPresent: z.boolean(),
    startTime: timeString,
    endTime: timeString,
    /** Blank (null) means no limit; the forms send null for a blank field. */
    capacity: z.number().int().min(1).max(10_000).nullish(),
    idempotencyKey: idemKey,
  })
  .superRefine((data, ctx) => {
    const [startHour, startMinute] = data.startTime.split(":").map(Number);
    const [endHour, endMinute] = data.endTime.split(":").map(Number);
    if (endHour * 60 + endMinute <= startHour * 60 + startMinute) {
      ctx.addIssue({ code: "custom", path: ["endTime"], message: "End time must be after the start time." });
    }
  });
export type SessionInput = z.infer<typeof sessionInput>;

export const attendanceInput = z.object({
  sessionId: id,
  memberId: id,
  status: z.enum(ATTENDANCE_STATUSES),
  idempotencyKey: idemKey,
});
export type AttendanceInput = z.infer<typeof attendanceInput>;

export const invoiceLineItem = z.object({
  description: z.string().trim().min(1).max(LIMITS.lineDescription),
  amount: money(0, 1_000_000_000),
});

export const invoiceInput = z.object({
  memberId: id,
  enrollmentId: id.nullable(),
  lineItems: z.array(invoiceLineItem).min(1).max(LIMITS.lineItems),
  dueDate: isoDate,
  status: z.enum(INVOICE_STATUSES),
  paymentMethod: z.enum(PAYMENT_METHODS).default("cash"),
  paymentDetails: z.string().trim().max(LIMITS.paymentDetails).default(""),
  idempotencyKey: idemKey,
});
export type InvoiceInput = z.input<typeof invoiceInput>;

export const invoicePatch = z.object({
  dueDate: isoDate.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  paymentDetails: z.string().trim().max(LIMITS.paymentDetails).optional(),
  idempotencyKey: idemKey,
});
export type InvoicePatch = z.infer<typeof invoicePatch>;

export const paymentInput = z.object({
  invoiceId: id,
  amount: money(1, 1_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  idempotencyKey: idemKey,
});
export type PaymentInput = z.infer<typeof paymentInput>;

export const payrollInput = z.object({
  trainerId: id,
  periodStart: isoDate,
  periodEnd: isoDate,
  idempotencyKey: idemKey,
});
export type PayrollInput = z.infer<typeof payrollInput>;

export const payrollPatch = z.object({
  status: z.enum(PAYROLL_STATUSES),
  idempotencyKey: idemKey,
});
export type PayrollPatch = z.infer<typeof payrollPatch>;

/** Parses untrusted input through a schema; the first problem becomes a field validation error. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.length ? String(issue.path[0]) : "input";
  throw new ValidationError(field, issue.message, "invalid");
}
