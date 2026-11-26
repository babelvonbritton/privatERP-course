// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { BackupValidator } from "@/lib/backup/BackupValidator";
import { effectiveInvoiceStatus, getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { resetCurrency, setCurrency } from "@/lib/currency";
import { createId } from "@/lib/storage/utils";
import type { Invoice } from "@/lib/domain/types";

afterEach(() => {
  resetCurrency();
});

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const memberInput = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});

async function euroInvoice(s: ReturnType<typeof getServices>, memberId: string) {
  return s.invoices.create({
    memberId,
    enrollmentId: null,
    lineItems: [
      { description: "Lesson", amount: 1.1 },
      { description: "Materials", amount: 2.2 },
    ],
    dueDate: "2026-12-01",
    status: "sent",
    idempotencyKey: createId(),
  });
}

async function pay(s: ReturnType<typeof getServices>, invoiceId: string, amount: number) {
  return s.invoices.recordPayment({ invoiceId, amount, method: "cash", idempotencyKey: createId() });
}

describe("money rounding: EUR invoices", () => {
  it("charges of 1.10 and 2.20 total exactly 3.30, and a payment of 3.30 pays the invoice in full", async () => {
    setCurrency("EUR");
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await euroInvoice(s, m.id);
    expect(invoice.total).toBe(3.3);
    await pay(s, invoice.id, 3.3);
    const current = (await s.invoices.get(invoice.id))!;
    expect(current.paidAmount).toBe(3.3);
    expect(current.status).toBe("paid");
  });

  it("a USD invoice with the same charges also reaches Paid", async () => {
    setCurrency("USD");
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await euroInvoice(s, m.id);
    expect(invoice.total).toBe(3.3);
    await pay(s, invoice.id, 3.3);
    const current = (await s.invoices.get(invoice.id))!;
    expect(current.status).toBe("paid");
  });

  it("deleting then restoring a payment round-trips to the same paid total and status", async () => {
    setCurrency("EUR");
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 3.3 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    await pay(s, invoice.id, 1.1);
    const second = await pay(s, invoice.id, 2.2);
    await s.invoices.removePayment(second.id);
    const entries = await s.trash.list();
    const entry = entries.find((e) => e.kind === "payment" && e.originalId === second.id)!;
    await s.trash.restore(entry.id);
    const current = (await s.invoices.get(invoice.id))!;
    expect(current.paidAmount).toBe(3.3);
    expect(current.status).toBe("paid");
  });

  it("an overpayment is still refused after rounding", async () => {
    setCurrency("EUR");
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await euroInvoice(s, m.id);
    await expect(pay(s, invoice.id, 3.31)).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("a dusty stored invoice reads as Paid", async () => {
    setCurrency("EUR");
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const row = {
      id: createId(),
      orgId: "org-owner",
      ownerId: "owner",
      createdAt: new Date("2026-11-20T00:00:00").getTime(),
      updatedAt: new Date("2026-11-20T00:00:00").getTime(),
      rev: 1,
      number: "INV-20261120-001",
      memberId: m.id,
      enrollmentId: null,
      lineItems: [
        { description: "Lesson", amount: 1.1 },
        { description: "Materials", amount: 2.2 },
      ],
      total: 1.1 + 2.2,
      paidAmount: 3.3,
      dueDate: "2026-12-01",
      status: "partial",
      paymentMethod: "cash",
      paymentDetails: "",
    } as unknown as Invoice;
    expect(row.total).toBe(3.3000000000000003);
    await getStorage().invoices.put(row);
    const stored = (await s.invoices.get(row.id))!;
    expect(effectiveInvoiceStatus(stored, "2026-11-20")).toBe("paid");
  });
});

describe("money rounding: payroll", () => {
  it("three sessions at 0.29 total exactly 0.87", async () => {
    setCurrency("EUR");
    const s = await freshServices();
    const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 0.29, status: "active", idempotencyKey: createId() });
    const m = await s.members.create(memberInput("Ana"));
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    for (const date of ["2026-11-02", "2026-11-09", "2026-11-16"]) {
      const session = await s.attendance.createSession({ courseId: c.id, date, topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
      await s.attendance.assignSessionAttendees(session.id, [m.id], createId());
      await s.attendance.mark(session.id, [{ memberId: m.id, status: "present" }], createId());
    }
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(run.total).toBe(0.87);
  });
});

describe("money rounding: backup validation", () => {
  it("a EUR backup validates when its payments sum to the stored paid amount in file order", () => {
    const now = Date.now();
    const memberId = createId();
    const invoiceId = createId();
    const base = { orgId: "org-owner", ownerId: "owner", createdAt: now, updatedAt: now, rev: 1 };
    const raw = {
      members: [{ ...base, id: memberId, name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active" }],
      trainers: [],
      courses: [],
      enrollments: [],
      sessions: [],
      attendance: [],
      invoices: [
        {
          ...base,
          id: invoiceId,
          number: "INV-20261120-001",
          memberId,
          enrollmentId: null,
          lineItems: [
            { description: "Lesson", amount: 1.1 },
            { description: "Materials", amount: 2.2 },
            { description: "Book", amount: 3.3 },
          ],
          total: 6.6,
          paidAmount: 6.6,
          dueDate: "2026-12-01",
          status: "paid",
          paymentMethod: "cash",
          paymentDetails: "",
        },
      ],
      // File order sums to 6.6000000000000005 in plain addition.
      payments: [1.1, 2.2, 3.3].map((amount) => ({ ...base, id: createId(), invoiceId, amount, at: now, method: "cash" })),
      payrollRuns: [],
      auditLog: [],
      writeKeys: [],
      settings: [{ key: "pref.currency", value: "EUR" }],
      attachments: [],
      trash: [],
    };
    expect(() => BackupValidator.validateData(raw, now)).not.toThrow();
  });
});
