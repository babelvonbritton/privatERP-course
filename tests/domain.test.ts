// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveInvoiceStatus, getServices, resetServices, today } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const member = (name: string) => ({ name, email: `${name.toLowerCase()}@example.com`, phone: "0812000000", notes: "", status: "active" as const, idempotencyKey: createId() });
const trainer = (name: string, rate: number) => ({ name, email: `${name.toLowerCase()}@example.com`, phone: "0812000001", subjects: ["Piano"], ratePerSession: rate, status: "active" as const, idempotencyKey: createId() });

describe("services", () => {
  it("idempotency: the same create key twice makes one record", async () => {
    const s = await freshServices();
    const key = createId();
    const first = await s.members.create({ ...member("Ana"), idempotencyKey: key });
    const second = await s.members.create({ ...member("Ana"), idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect(await s.members.list()).toHaveLength(1);
  });

  it("idempotency: the same update key twice applies once", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const key = createId();
    const first = await s.members.update(m.id, { phone: "0812999999", idempotencyKey: key });
    const second = await s.members.update(m.id, { phone: "0812999999", idempotencyKey: key });
    expect(first.rev).toBe(2);
    expect(second.rev).toBe(2);
    expect(second.phone).toBe("0812999999");
  });

  it("invoice: number is sequential per day and total is the sum of lines", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const lines = [
      { description: "Course fee", amount: 500000 },
      { description: "Book", amount: 75000 },
    ];
    const first = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: lines, dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    const second = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Course fee", amount: 100000 }], dueDate: "2026-12-01", status: "draft", idempotencyKey: createId() });
    expect(first.number).toMatch(/^INV-\d{8}-001$/);
    expect(second.number).toMatch(/^INV-\d{8}-002$/);
    expect(first.total).toBe(575000);
    expect(first.paidAmount).toBe(0);
  });

  it("invoice: partial payment then full payment moves the status", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 400000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    await s.invoices.recordPayment({ invoiceId: inv.id, amount: 150000, method: "transfer", idempotencyKey: createId() });
    let current = (await s.invoices.get(inv.id))!;
    expect(current.paidAmount).toBe(150000);
    expect(current.status).toBe("partial");
    await s.invoices.recordPayment({ invoiceId: inv.id, amount: 250000, method: "cash", idempotencyKey: createId() });
    current = (await s.invoices.get(inv.id))!;
    expect(current.paidAmount).toBe(400000);
    expect(current.status).toBe("paid");
  });

  it("invoice: overpayment and payment on a draft are rejected", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const sent = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    await expect(s.invoices.recordPayment({ invoiceId: sent.id, amount: 100001, method: "cash", idempotencyKey: createId() })).rejects.toThrow();
    const draft = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "draft", idempotencyKey: createId() });
    await expect(s.invoices.recordPayment({ invoiceId: draft.id, amount: 1000, method: "cash", idempotencyKey: createId() })).rejects.toThrow();
  });

  it("invoice: overdue is derived from the due date, never stored", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2020-01-01", status: "sent", idempotencyKey: createId() });
    expect(inv.status).toBe("sent");
    expect(effectiveInvoiceStatus(inv, today())).toBe("overdue");
  });

  it("invoice: status can only be set to draft or sent by hand", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "draft", idempotencyKey: createId() });
    await expect(s.invoices.update(inv.id, { status: "paid", idempotencyKey: createId() })).rejects.toThrow();
  });

  it("payroll: a run counts attended sessions times the rate, and regenerating returns the same run", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 150000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, capacity: 10, trainerId: t.id, scheduleWeekday: 1, scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() });
    const session = await s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "Scales", trainerId: t.id, trainerPresent: false, idempotencyKey: createId() });
    await s.attendance.setTrainerPresent(session.id, true, createId());
    await s.attendance.mark(session.id, [{ memberId: m.id, status: "present" }], createId());
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(run.sessionCount).toBe(1);
    expect(run.ratePerSession).toBe(150000);
    expect(run.total).toBe(150000);
    const again = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(again.id).toBe(run.id);
    expect(await s.payroll.list()).toHaveLength(1);
  });

  it("search: members are found by name, email and phone prefix", async () => {
    const s = await freshServices();
    await s.members.create(member("Ana"));
    await s.members.create({ ...member("Budi"), email: "budi@other.com", phone: "0899000000" });
    expect((await s.members.search("an")).map((m) => m.name)).toEqual(["Ana"]);
    expect((await s.members.search("budi@other")).map((m) => m.name)).toEqual(["Budi"]);
    expect((await s.members.search("0899")).map((m) => m.name)).toEqual(["Budi"]);
    expect(await s.members.search("zzz")).toHaveLength(0);
  });

  it("delete: linked members, trainers, and courses are blocked; invoice deletion also removes payments", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, capacity: 5, trainerId: t.id, scheduleWeekday: 1, scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() });
    await expect(s.members.remove(m.id)).rejects.toThrow();
    await expect(s.trainers.remove(t.id)).rejects.toThrow();
    await expect(s.courses.remove(c.id)).rejects.toThrow();
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    const payment = await s.invoices.recordPayment({ invoiceId: inv.id, amount: 100000, method: "cash", idempotencyKey: createId() });
    await s.invoices.remove(inv.id);
    expect(await s.invoices.get(inv.id)).toBeUndefined();
    expect(await s.invoices.listPayments(inv.id)).toEqual([]);
    expect(await getStorage().payments.get(payment.id)).toBeUndefined();
    expect((await getStorage().integrity.run()).ok).toBe(true);
  });

  it("enrollment and session duplicates are rejected", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, capacity: 5, trainerId: t.id, scheduleWeekday: 1, scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() });
    await expect(s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() })).rejects.toThrow();
    await s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "One", trainerId: t.id, trainerPresent: false, idempotencyKey: createId() });
    await expect(s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "Two", trainerId: t.id, trainerPresent: false, idempotencyKey: createId() })).rejects.toThrow();
  });

  it("invoice: removing the last payment returns the invoice to sent, not paid", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 400000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    const payment = await s.invoices.recordPayment({ invoiceId: inv.id, amount: 400000, method: "cash", idempotencyKey: createId() });
    expect((await s.invoices.get(inv.id))!.status).toBe("paid");
    await s.invoices.removePayment(payment.id);
    const current = (await s.invoices.get(inv.id))!;
    expect(current.paidAmount).toBe(0);
    expect(current.status).toBe("sent");
  });

  it("invoice: a paid or partial invoice keeps its status when edited", async () => {
    const s = await freshServices();
    const m = await s.members.create(member("Ana"));
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 400000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    await s.invoices.recordPayment({ invoiceId: inv.id, amount: 100000, method: "cash", idempotencyKey: createId() });
    await expect(s.invoices.update(inv.id, { status: "draft", idempotencyKey: createId() })).rejects.toThrow();
    expect((await s.invoices.get(inv.id))!.status).toBe("partial");
  });

  it("payroll: two generates at once still make one run", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 150000));
    const [first, second] = await Promise.all([
      s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() }),
      s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() }),
    ]);
    expect(first.id).toBe(second.id);
    expect(await s.payroll.list()).toHaveLength(1);
  });

  it("enrollment and session: two creates at once still make one record", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, capacity: 5, trainerId: t.id, scheduleWeekday: 1, scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
    const enrollments = await Promise.allSettled([
      s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() }),
      s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() }),
    ]);
    expect(enrollments.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.courses.listEnrollmentsByCourse(c.id)).toHaveLength(1);
    const sessions = await Promise.allSettled([
      s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "One", trainerId: t.id, trainerPresent: false, idempotencyKey: createId() }),
      s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "Two", trainerId: t.id, trainerPresent: false, idempotencyKey: createId() }),
    ]);
    expect(sessions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.attendance.listSessionsByCourse(c.id)).toHaveLength(1);
  });

  it("search: invoices are found by member name, courses by trainer name", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, capacity: 5, trainerId: t.id, scheduleWeekday: 1, scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    expect((await s.invoices.search("ana")).map((i) => i.id)).toEqual([inv.id]);
    expect((await s.invoices.search(inv.number.slice(0, 8))).map((i) => i.id)).toEqual([inv.id]);
    expect((await s.courses.search("budi")).map((x) => x.id)).toEqual([c.id]);
    expect((await s.courses.search("pia")).map((x) => x.id)).toEqual([c.id]);
  });

  it("audit: writes are logged", async () => {
    const s = await freshServices();
    const storage = getStorage();
    await s.members.create(member("Ana"));
    const log = await storage.audit.all();
    expect(log.some((e) => e.entity === "member" && e.action === "member.create")).toBe(true);
  });
});
