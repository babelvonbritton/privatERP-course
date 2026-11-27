// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { effectiveInvoiceStatus, getServices, resetServices, today } from "@/lib/domain/services";
import { courseWeekdays, sessionDurationHours } from "@/lib/domain/types";
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
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    const session = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    await s.attendance.setTrainerPresent(session.id, true, createId());
    await s.attendance.assignSessionAttendees(session.id, [m.id], createId());
    await s.attendance.mark(session.id, [{ memberId: m.id, status: "present" }], createId());
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(run.sessionCount).toBe(1);
    expect(run.ratePerSession).toBe(150000);
    expect(run.total).toBe(150000);
    const again = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(again.id).toBe(run.id);
    expect(await s.payroll.list()).toHaveLength(1);
  });

  it("payroll: an absent session is not paid, and a run with only absent sessions pays 0", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 150000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    const present = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    const absent = await s.attendance.createSession({ courseId: c.id, date: "2026-11-16", topic: "Arpeggios", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    await s.attendance.assignSessionAttendees(present.id, [m.id], createId());
    await s.attendance.assignSessionAttendees(absent.id, [m.id], createId());
    await s.attendance.mark(present.id, [{ memberId: m.id, status: "present" }], createId());
    await s.attendance.mark(absent.id, [{ memberId: m.id, status: "present" }], createId());
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(run.sessionCount).toBe(1);
    expect(run.total).toBe(150000);
    expect(run.sessionIds).toEqual([present.id]);
    await s.attendance.createSession({ courseId: c.id, date: "2026-12-07", topic: "December", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    const onlyAbsent = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-12-01", periodEnd: "2026-12-31", idempotencyKey: createId() });
    expect(onlyAbsent.sessionCount).toBe(0);
    expect(onlyAbsent.total).toBe(0);
    expect(onlyAbsent.sessionIds).toEqual([]);
  });

  it("payroll: regenerating a draft run after the trainer is marked absent drops the session, a paid run never changes", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 150000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    const session = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(run.sessionCount).toBe(1);
    expect(run.total).toBe(150000);
    await s.attendance.setTrainerPresent(session.id, false, createId());
    const refreshed = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(refreshed.id).toBe(run.id);
    expect(refreshed.sessionCount).toBe(0);
    expect(refreshed.total).toBe(0);
    expect(refreshed.sessionIds).toEqual([]);
    expect(await s.payroll.list()).toHaveLength(1);
    await s.attendance.setTrainerPresent(session.id, true, createId());
    const back = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(back.sessionCount).toBe(1);
    expect(back.total).toBe(150000);
    await s.payroll.setStatus(run.id, { status: "paid", idempotencyKey: createId() });
    await s.attendance.setTrainerPresent(session.id, false, createId());
    const frozen = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(frozen.id).toBe(run.id);
    expect(frozen.sessionCount).toBe(1);
    expect(frozen.total).toBe(150000);
    expect(frozen.status).toBe("paid");
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
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
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
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    await expect(s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() })).rejects.toThrow();
    await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "One", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    await expect(s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Two", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() })).rejects.toThrow();
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
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    const enrollments = await Promise.allSettled([
      s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() }),
      s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() }),
    ]);
    expect(enrollments.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.courses.listEnrollmentsByCourse(c.id)).toHaveLength(1);
    const sessions = await Promise.allSettled([
      s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "One", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() }),
      s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Two", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() }),
    ]);
    expect(sessions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await s.attendance.listSessionsByCourse(c.id)).toHaveLength(1);
  });

  it("search: invoices are found by member name, courses by title only", async () => {
    const s = await freshServices();
    await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    expect((await s.invoices.search("ana")).map((i) => i.id)).toEqual([inv.id]);
    expect((await s.invoices.search(inv.number.slice(0, 8))).map((i) => i.id)).toEqual([inv.id]);
    expect((await s.courses.search("budi")).map((x) => x.id)).toEqual([]);
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

describe("session times, weekdays, and attended hours", () => {
  const makeCourse = (title = "Piano", days: number[] = [1, 3, 5]) => ({
    title,
    description: "",
    level: "Beginner",
    price: 100000,
    requiredSkills: ["Piano"],
    scheduleWeekdays: days,
    status: "active" as const,
    idempotencyKey: createId(),
  });
  const makeSession = (courseId: string, trainerId: string, date: string, topic: string, start = "09:00", end = "10:30") => ({
    courseId,
    date,
    topic,
    trainerId,
    trainerPresent: true,
    startTime: start,
    endTime: end,
    idempotencyKey: createId(),
  });

  it("sessionDurationHours derives hours from the time range", () => {
    expect(sessionDurationHours({ startTime: "09:00", endTime: "10:30" })).toBe(1.5);
    expect(sessionDurationHours({ startTime: "09:00", endTime: "09:45" })).toBe(0.75);
    expect(sessionDurationHours({ startTime: "09:00", endTime: "09:00" })).toBeNull();
    expect(sessionDurationHours({ startTime: "10:00", endTime: "09:00" })).toBeNull();
    expect(sessionDurationHours({ startTime: "", endTime: "10:00" })).toBeNull();
    expect(sessionDurationHours({ startTime: "09:00", endTime: "" })).toBeNull();
    expect(sessionDurationHours({ startTime: "09:00", endTime: "25:00" })).toBeNull();
  });

  it("courseWeekdays tolerates a legacy single weekday", () => {
    expect(courseWeekdays({ scheduleWeekdays: [1, 3, 5] })).toEqual([1, 3, 5]);
    expect(courseWeekdays({ scheduleWeekdays: [5, 1, 1] })).toEqual([1, 5]);
    expect(courseWeekdays({ scheduleWeekday: 2 } as never)).toEqual([2]);
    expect(courseWeekdays({ scheduleWeekday: 9 } as never)).toEqual([]);
    expect(courseWeekdays({ scheduleWeekdays: [] })).toEqual([]);
  });

  it("course: several weekdays are stored sorted, an empty list is rejected", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const c = await s.courses.create(makeCourse("Piano", [5, 1, 3]));
    expect(c.scheduleWeekdays).toEqual([1, 3, 5]);
    await expect(s.courses.create(makeCourse("Guitar", []))).rejects.toThrow();
  });

  it("course: updating weekdays replaces the list", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const c = await s.courses.create(makeCourse("Piano", [1]));
    const updated = await s.courses.update(c.id, { scheduleWeekdays: [2, 4], idempotencyKey: createId() });
    expect(updated.scheduleWeekdays).toEqual([2, 4]);
  });

  it("session: end at or before start is rejected, a valid range is stored", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const c = await s.courses.create(makeCourse());
    await expect(s.attendance.createSession(makeSession(c.id, t.id, "2026-11-09", "One", "10:00", "10:00"))).rejects.toThrow();
    await expect(s.attendance.createSession(makeSession(c.id, t.id, "2026-11-09", "One", "10:00", "09:00"))).rejects.toThrow();
    const ok = await s.attendance.createSession(makeSession(c.id, t.id, "2026-11-09", "One", "09:00", "10:30"));
    expect(ok.startTime).toBe("09:00");
    expect(ok.endTime).toBe("10:30");
  });

  it("attendedHours: present and late count, absent and other courses do not", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const piano = await s.courses.create(makeCourse("Piano", [1, 3]));
    const guitar = await s.courses.create(makeCourse("Guitar", [2]));
    await s.courses.enroll({ memberId: m.id, courseId: piano.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: guitar.id, startDate: "2026-11-03", endDate: null, status: "active", idempotencyKey: createId() });
    const s1 = await s.attendance.createSession(makeSession(piano.id, t.id, "2026-11-09", "One", "09:00", "10:30"));
    const s2 = await s.attendance.createSession(makeSession(piano.id, t.id, "2026-11-11", "Two", "09:00", "10:30"));
    const s3 = await s.attendance.createSession(makeSession(piano.id, t.id, "2026-11-18", "Three", "09:00", "09:45"));
    const g1 = await s.attendance.createSession(makeSession(guitar.id, t.id, "2026-11-10", "Strings", "09:00", "10:30"));
    for (const sess of [s1, s2, s3, g1]) await s.attendance.assignSessionAttendees(sess.id, [m.id], createId());
    await s.attendance.mark(s1.id, [{ memberId: m.id, status: "present" }], createId());
    await s.attendance.mark(s2.id, [{ memberId: m.id, status: "late" }], createId());
    await s.attendance.mark(s3.id, [{ memberId: m.id, status: "absent" }], createId());
    await s.attendance.mark(g1.id, [{ memberId: m.id, status: "present" }], createId());
    expect(await s.attendance.attendedHours(m.id, piano.id)).toBe(3);
    expect(await s.attendance.attendedHours(m.id, guitar.id)).toBe(1.5);
  });

  it("dashboardSummary: rows per member and course, filters narrow them", async () => {
    const s = await freshServices();
    const budi = await s.trainers.create(trainer("Budi", 100000));
    const siti = await s.trainers.create(trainer("Siti", 120000));
    const ana = await s.members.create(member("Ana"));
    const ben = await s.members.create(member("Ben"));
    const piano = await s.courses.create(makeCourse("Piano", [1]));
    const guitar = await s.courses.create(makeCourse("Guitar", [2]));
    for (const [mem, c] of [
      [ana, piano],
      [ana, guitar],
      [ben, piano],
    ] as const) {
      await s.courses.enroll({ memberId: mem.id, courseId: c.id, startDate: c.id === guitar.id ? "2026-11-03" : "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    }
    const p1 = await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-09", "One", "09:00", "10:30"));
    const p2 = await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-16", "Two", "09:00", "10:30"));
    const g1 = await s.attendance.createSession(makeSession(guitar.id, siti.id, "2026-11-10", "Strings", "09:00", "09:45"));
    await s.attendance.assignSessionAttendees(p1.id, [ana.id, ben.id], createId());
    await s.attendance.assignSessionAttendees(p2.id, [ana.id, ben.id], createId());
    await s.attendance.assignSessionAttendees(g1.id, [ana.id], createId());
    await s.attendance.mark(p1.id, [{ memberId: ana.id, status: "present" }, { memberId: ben.id, status: "absent" }], createId());
    await s.attendance.mark(p2.id, [{ memberId: ana.id, status: "late" }, { memberId: ben.id, status: "present" }], createId());
    await s.attendance.mark(g1.id, [{ memberId: ana.id, status: "present" }], createId());
    const all = await s.attendance.dashboardSummary();
    expect(all.rows).toHaveLength(3);
    expect(all.totalSessions).toBe(5);
    expect(all.totalAttendedHours).toBe(5.25);
    expect(all.overallRate).toBe(80);
    const anaPiano = all.rows.find((r) => r.memberId === ana.id && r.courseId === piano.id)!;
    expect(anaPiano.sessions).toBe(2);
    expect(anaPiano.present).toBe(1);
    expect(anaPiano.late).toBe(1);
    expect(anaPiano.rate).toBe(100);
    expect(anaPiano.attendedHours).toBe(3);
    const benPiano = all.rows.find((r) => r.memberId === ben.id)!;
    expect(benPiano.rate).toBe(50);
    expect(benPiano.attendedHours).toBe(1.5);
    const byTrainer = await s.attendance.dashboardSummary({ trainerId: siti.id });
    expect(byTrainer.rows).toHaveLength(1);
    expect(byTrainer.rows[0].courseTitle).toBe("Guitar");
    const byMember = await s.attendance.dashboardSummary({ memberId: ben.id });
    expect(byMember.rows).toHaveLength(1);
    const byCourse = await s.attendance.dashboardSummary({ courseId: guitar.id });
    expect(byCourse.rows).toHaveLength(1);
    expect(byCourse.totalAttendedHours).toBe(0.75);
  });

  it("course: no time is stored on a course", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const c = await s.courses.create(makeCourse("Piano", [1]));
    expect(c).not.toHaveProperty("scheduleTime");
    expect(c.scheduleWeekdays).toEqual([1]);
  });

  it("trainerDashboardSummary: rows per trainer and course, only present sessions count toward hours", async () => {
    const s = await freshServices();
    const budi = await s.trainers.create(trainer("Budi", 100000));
    const siti = await s.trainers.create(trainer("Siti", 120000));
    const piano = await s.courses.create(makeCourse("Piano", [1]));
    const guitar = await s.courses.create(makeCourse("Guitar", [2]));
    await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-09", "One", "09:00", "10:30"));
    await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-16", "Two", "09:00", "10:30"));
    const p3 = await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-23", "Three", "09:00", "09:45"));
    await s.attendance.createSession(makeSession(guitar.id, siti.id, "2026-11-10", "Strings", "09:00", "09:45"));
    await s.attendance.setTrainerPresent(p3.id, false, createId());
    const all = await s.attendance.trainerDashboardSummary();
    expect(all.rows).toHaveLength(2);
    expect(all.totalSessions).toBe(4);
    expect(all.totalHoursTaught).toBe(3.75);
    expect(all.overallRate).toBe(75);
    const budiPiano = all.rows.find((r) => r.trainerId === budi.id)!;
    expect(budiPiano.sessions).toBe(3);
    expect(budiPiano.present).toBe(2);
    expect(budiPiano.absent).toBe(1);
    expect(budiPiano.rate).toBe(67);
    expect(budiPiano.hoursTaught).toBe(3);
    const byTrainer = await s.attendance.trainerDashboardSummary({ trainerId: siti.id });
    expect(byTrainer.rows).toHaveLength(1);
    expect(byTrainer.rows[0].courseTitle).toBe("Guitar");
    expect(byTrainer.rows[0].hoursTaught).toBe(0.75);
    const byCourse = await s.attendance.trainerDashboardSummary({ courseId: piano.id });
    expect(byCourse.rows).toHaveLength(1);
    expect(byCourse.totalHoursTaught).toBe(3);
  });

  it("trainerDashboardSummary: hours are per course and only count sessions the trainer was present for", async () => {
    const s = await freshServices();
    const budi = await s.trainers.create(trainer("Budi", 100000));
    const piano = await s.courses.create(makeCourse("Piano", [1]));
    const guitar = await s.courses.create(makeCourse("Guitar", [2]));
    await s.attendance.createSession(makeSession(piano.id, budi.id, "2026-11-09", "One", "09:00", "10:30"));
    const g1 = await s.attendance.createSession(makeSession(guitar.id, budi.id, "2026-11-10", "Strings", "09:00", "09:45"));
    await s.attendance.setTrainerPresent(g1.id, false, createId());
    const summary = await s.attendance.trainerDashboardSummary({ trainerId: budi.id });
    expect(summary.rows).toHaveLength(2);
    const pianoRow = summary.rows.find((r) => r.courseId === piano.id)!;
    expect(pianoRow.sessions).toBe(1);
    expect(pianoRow.hoursTaught).toBe(1.5);
    const guitarRow = summary.rows.find((r) => r.courseId === guitar.id)!;
    expect(guitarRow.sessions).toBe(1);
    expect(guitarRow.present).toBe(0);
    expect(guitarRow.hoursTaught).toBe(0);
    expect(summary.totalHoursTaught).toBe(1.5);
  });
});

describe("weekly slot: sessions and enrollments stay on scheduled weekdays", () => {
  const SAT = "2026-11-28";
  const SUN = "2026-11-29";
  const MON = "2026-11-30";

  async function weekendCourse() {
    const s = await freshServices();
    const t = await s.trainers.create(trainer("Budi", 100000));
    const m = await s.members.create(member("Ana"));
    const c = await s.courses.create({ title: "Weekend Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [6, 0], status: "active", idempotencyKey: createId() });
    return { s, t, m, c };
  }

  const sessionOn = (courseId: string, trainerId: string, date: string, topic = "Scales") => ({
    courseId,
    date,
    topic,
    trainerId,
    trainerPresent: false,
    startTime: "09:00",
    endTime: "10:00",
    idempotencyKey: createId(),
  });

  it("session on a scheduled weekday is accepted, on another weekday rejected at the service layer", async () => {
    const { s, t, c } = await weekendCourse();
    const saturday = await s.attendance.createSession(sessionOn(c.id, t.id, SAT));
    expect(saturday.date).toBe(SAT);
    await expect(s.attendance.createSession(sessionOn(c.id, t.id, MON, "Monday class"))).rejects.toThrow("not one of the course's scheduled weekdays");
  });

  it("enrollment starting on a scheduled weekday is accepted, on another weekday rejected at the service layer", async () => {
    const { s, m, c } = await weekendCourse();
    const sunday = await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: SUN, endDate: null, status: "active", idempotencyKey: createId() });
    expect(sunday.startDate).toBe(SUN);
    await expect(s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: MON, endDate: null, status: "active", idempotencyKey: createId() })).rejects.toThrow("not one of the course's scheduled weekdays");
  });

  it("the rejection names the allowed weekdays for the translated message", async () => {
    const { s, t, c } = await weekendCourse();
    try {
      await s.attendance.createSession(sessionOn(c.id, t.id, MON));
      expect.unreachable("a Monday session on a weekend course must be rejected");
    } catch (e) {
      const err = e as { kind?: string; vars?: Record<string, string | number> };
      expect(err?.kind).toBe("notScheduledDay");
      expect(err?.vars?.days).toBe("0,6");
    }
  });

  it("moving an enrollment to a non-slot weekday is rejected, but an untouched out-of-slot enrollment can still be updated", async () => {
    const { s, t, m, c } = await weekendCourse();
    const weekdayCourse = await s.courses.create({ title: "Weekday Piano", description: "", level: "Beginner", price: 100000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    const enrollment = await s.courses.enroll({ memberId: m.id, courseId: weekdayCourse.id, startDate: MON, endDate: null, status: "active", idempotencyKey: createId() });
    await s.courses.update(weekdayCourse.id, { scheduleWeekdays: [6, 0], idempotencyKey: createId() });
    await expect(s.courses.updateEnrollment(enrollment.id, { startDate: "2026-12-07", idempotencyKey: createId() })).rejects.toThrow("not one of the course's scheduled weekdays");
    const kept = await s.courses.updateEnrollment(enrollment.id, { status: "completed", idempotencyKey: createId() });
    expect(kept.startDate).toBe(MON);
    expect(kept.status).toBe("completed");
    expect(c.title).toBe("Weekend Piano");
  });
});
