import type { OlaseenaDatabase } from "./OlaseenaDatabase";
import type { Clock } from "./types";
import { paidMatches } from "@/lib/money";

export type IntegrityCode =
  | "ORPHAN_ENROLLMENT"
  | "ORPHAN_SESSION"
  | "ORPHAN_ATTENDANCE"
  | "ORPHAN_INVOICE"
  | "ORPHAN_PAYMENT"
  | "ORPHAN_PAYROLL"
  | "DUPLICATE_INVOICE_NUMBER"
  | "INVOICE_PAID_MISMATCH";

export interface IntegrityIssue {
  code: IntegrityCode;
  id: string;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: number;
  issues: IntegrityIssue[];
}

/** Read-only verification of references and money totals across stores. Never modifies data. */
export class IntegrityChecker {
  constructor(private readonly db: OlaseenaDatabase, private readonly clock: Clock) {}

  async run(): Promise<IntegrityReport> {
    const [members, trainers, courses, enrollments, sessions, attendance, invoices, payments, payrollRuns] = await Promise.all([
      this.db.members.toArray(),
      this.db.trainers.toArray(),
      this.db.courses.toArray(),
      this.db.enrollments.toArray(),
      this.db.sessions.toArray(),
      this.db.attendance.toArray(),
      this.db.invoices.toArray(),
      this.db.payments.toArray(),
      this.db.payrollRuns.toArray(),
    ]);
    const memberIds = new Set(members.map((m) => m.id));
    const trainerIds = new Set(trainers.map((t) => t.id));
    const courseIds = new Set(courses.map((c) => c.id));
    const enrollmentIds = new Set(enrollments.map((e) => e.id));
    const sessionIds = new Set(sessions.map((s) => s.id));
    const invoiceIds = new Set(invoices.map((i) => i.id));
    const issues: IntegrityIssue[] = [];

    for (const e of enrollments) {
      if (!memberIds.has(e.memberId) || !courseIds.has(e.courseId)) {
        issues.push({ code: "ORPHAN_ENROLLMENT", id: e.id, message: "Enrollment points to a missing member or course" });
      }
    }
    for (const s of sessions) {
      if (!courseIds.has(s.courseId) || !trainerIds.has(s.trainerId)) {
        issues.push({ code: "ORPHAN_SESSION", id: s.id, message: "Session points to a missing course or trainer" });
      }
    }
    for (const a of attendance) {
      if (!sessionIds.has(a.sessionId) || !memberIds.has(a.memberId)) {
        issues.push({ code: "ORPHAN_ATTENDANCE", id: a.id, message: "Attendance points to a missing session or member" });
      }
    }
    for (const i of invoices) {
      if (!memberIds.has(i.memberId) || (i.enrollmentId !== null && !enrollmentIds.has(i.enrollmentId))) {
        issues.push({ code: "ORPHAN_INVOICE", id: i.id, message: "Invoice points to a missing member or enrollment" });
      }
    }
    for (const p of payments) {
      if (!invoiceIds.has(p.invoiceId)) issues.push({ code: "ORPHAN_PAYMENT", id: p.id, message: "Payment points to a missing invoice" });
    }
    for (const r of payrollRuns) {
      if (!trainerIds.has(r.trainerId) || r.sessionIds.some((id) => !sessionIds.has(id))) {
        issues.push({ code: "ORPHAN_PAYROLL", id: r.id, message: "Payroll run points to a missing trainer or session" });
      }
    }
    const numbers = new Set<string>();
    for (const i of invoices) {
      if (numbers.has(i.number)) issues.push({ code: "DUPLICATE_INVOICE_NUMBER", id: i.id, message: "Two invoices share a number" });
      numbers.add(i.number);
    }
    const paidByInvoice = new Map<string, number>();
    for (const p of payments) paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + p.amount);
    for (const i of invoices) {
      if (!paidMatches(paidByInvoice.get(i.id) ?? 0, i.paidAmount)) {
        issues.push({ code: "INVOICE_PAID_MISMATCH", id: i.id, message: "Invoice paid total does not match its payments" });
      }
    }
    return { ok: issues.length === 0, checkedAt: this.clock(), issues };
  }
}
