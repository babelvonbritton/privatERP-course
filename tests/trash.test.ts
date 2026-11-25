// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "@/lib/backup/BackupService";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, resetServices, Services } from "@/lib/domain/services";
import { trashDaysRemaining } from "@/lib/domain/trash";
import type { TrashEntry } from "@/lib/domain/trash";
import { OWNER_ACTOR } from "@/lib/domain/types";
import { AppError } from "@/lib/errors/AppError";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import type { PreparedAttachment } from "@/lib/attachments/compress";

/**
 * Trash bin (v0.4.0): deleting a record moves it to trash instead of removing
 * it for good, and restoring puts it back. The implementation lives in the
 * trash service (src/lib/domain/trash.ts), reached as getServices().trash.
 * These tests only use that public contract plus the existing services.
 */

const DAY = 24 * 60 * 60 * 1000;
const noop = () => {};

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

/** Services with a fixed clock, so invoice numbers and trash timestamps are repeatable. */
async function freshServicesWithClock(now: number) {
  await resetStorage();
  resetServices();
  return new Services(getStorage(), OWNER_ACTOR, () => now);
}

const memberInput = (name: string) => ({
  name,
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});
const trainerInput = (name: string, rate = 100000) => ({
  name,
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: "0812000001",
  subjects: ["Piano"],
  ratePerSession: rate,
  status: "active" as const,
  idempotencyKey: createId(),
});
const courseInput = (title = "Piano Basics") => ({
  title,
  description: "",
  level: "Beginner",
  price: 500000,
  capacity: 10,
  requiredSkills: ["Piano"],
  scheduleWeekdays: [1],
  status: "active" as const,
  idempotencyKey: createId(),
});

async function seedBasic(s: Services) {
  const t = await s.trainers.create(trainerInput("Budi"));
  const m = await s.members.create(memberInput("Ana"));
  const c = await s.courses.create(courseInput());
  return { t, m, c };
}

async function seedEnrolled(s: Services) {
  const base = await seedBasic(s);
  const enrollment = await s.courses.enroll({ memberId: base.m.id, courseId: base.c.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
  return { ...base, enrollment };
}

async function seedSession(s: Services, date = "2026-11-09") {
  const base = await seedEnrolled(s);
  const session = await s.attendance.createSession({ courseId: base.c.id, date, topic: "Scales", trainerId: base.t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
  const attendance = await s.attendance.mark(session.id, [{ memberId: base.m.id, status: "present" }], createId());
  return { ...base, session, attendance };
}

async function makeInvoice(s: Services, memberId: string, amount = 400000, enrollmentId: string | null = null) {
  return s.invoices.create({
    memberId,
    enrollmentId,
    lineItems: [{ description: "Fee", amount }],
    dueDate: "2026-12-01",
    status: "sent",
    idempotencyKey: createId(),
  });
}

async function seedInvoiceWithPayment(s: Services, memberId: string, total = 400000, paid = 150000) {
  const invoice = await makeInvoice(s, memberId, total);
  const payment = await s.invoices.recordPayment({ invoiceId: invoice.id, amount: paid, method: "cash", idempotencyKey: createId() });
  return { invoice, payment };
}

async function trashOf(s: Services, kind: TrashEntry["kind"], originalId: string): Promise<TrashEntry> {
  const entries = await s.trash.list();
  const entry = entries.find((e) => e.kind === kind && e.originalId === originalId);
  expect(entry).toBeDefined();
  return entry!;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
  }
}

function toFile(zip: Uint8Array, name: string): File {
  return new File([zip as BlobPart], name, { type: "application/zip" });
}

const preparedImage = (): PreparedAttachment => ({
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
  fileName: "receipt.png",
  mimeType: "image/png",
  width: 10,
  height: 10,
  sizeBytes: 4,
});

describe("trash: round-trips", () => {
  it("member: trash removes the live record, restore brings it back identical", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    await s.members.remove(m.id);
    expect(await s.members.get(m.id)).toBeUndefined();
    const entry = await trashOf(s, "member", m.id);
    expect(entry.kind).toBe("member");
    expect(entry.label).toBe("Ana");
    expect(entry.snapshot).toEqual(m);
    expect(entry.deletedAt).toBeGreaterThan(0);
    await s.trash.restore(entry.id);
    expect(await s.members.get(m.id)).toEqual(m);
    expect(await s.trash.list()).toHaveLength(0);
  });

  it("trainer: trash and restore round-trip", async () => {
    const s = await freshServices();
    const t = await s.trainers.create(trainerInput("Budi", 150000));
    await s.trainers.remove(t.id);
    expect(await s.trainers.get(t.id)).toBeUndefined();
    const entry = await trashOf(s, "trainer", t.id);
    expect(entry.label).toBe("Budi");
    expect(entry.snapshot).toEqual(t);
    await s.trash.restore(entry.id);
    expect(await s.trainers.get(t.id)).toEqual(t);
  });

  it("course: trash and restore round-trip", async () => {
    const s = await freshServices();
    const { t, c } = await seedBasic(s);
    void t;
    await s.courses.remove(c.id);
    expect(await s.courses.get(c.id)).toBeUndefined();
    const entry = await trashOf(s, "course", c.id);
    expect(entry.label).toBe("Piano Basics");
    expect(entry.snapshot).toEqual(c);
    await s.trash.restore(entry.id);
    expect(await s.courses.get(c.id)).toEqual(c);
  });

  it("enrollment: trash and restore round-trip", async () => {
    const s = await freshServices();
    const { enrollment } = await seedEnrolled(s);
    await s.courses.removeEnrollment(enrollment.id);
    expect((await s.courses.listEnrollmentsByCourse(enrollment.courseId))).toHaveLength(0);
    const entry = await trashOf(s, "enrollment", enrollment.id);
    expect(entry.label).toContain("Ana");
    expect(entry.label).toContain("Piano Basics");
    expect(entry.snapshot).toEqual(enrollment);
    await s.trash.restore(entry.id);
    const restored = await s.courses.listEnrollmentsByCourse(enrollment.courseId);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(enrollment);
  });

  it("session: trash and restore bring the session and its attendance rows back", async () => {
    const s = await freshServices();
    const { session, attendance } = await seedSession(s);
    await s.attendance.removeSession(session.id);
    expect(await s.attendance.getSession(session.id)).toBeUndefined();
    const entry = await trashOf(s, "session", session.id);
    expect(entry.label).toContain("Piano Basics");
    expect(entry.label).toContain("2026-11-09");
    expect(entry.snapshot).toEqual(session);
    expect(Array.isArray(entry.related)).toBe(true);
    await s.trash.restore(entry.id);
    expect(await s.attendance.getSession(session.id)).toEqual(session);
    const rows = await s.attendance.listAttendance(session.id);
    expect(rows).toHaveLength(attendance.length);
    expect(rows.map((r) => ({ memberId: r.memberId, status: r.status }))).toEqual(
      attendance.map((r) => ({ memberId: r.memberId, status: r.status })),
    );
  });

  it("invoice: trash and restore bring the invoice and its payments back", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const { invoice, payment } = await seedInvoiceWithPayment(s, m.id);
    const before = (await s.invoices.get(invoice.id))!;
    expect(before.status).toBe("partial");
    await s.invoices.remove(invoice.id);
    expect(await s.invoices.get(invoice.id)).toBeUndefined();
    expect(await s.invoices.listPayments(invoice.id)).toEqual([]);
    const entry = await trashOf(s, "invoice", invoice.id);
    expect(entry.label).toBe(invoice.number);
    expect(entry.snapshot).toEqual(before);
    expect(Array.isArray(entry.related)).toBe(true);
    await s.trash.restore(entry.id);
    const restored = (await s.invoices.get(invoice.id))!;
    expect(restored).toEqual(before);
    const payments = await s.invoices.listPayments(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toEqual(payment);
  });

  it("payment: trash removes it and re-derives the invoice; restore puts it back", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const { invoice, payment } = await seedInvoiceWithPayment(s, m.id);
    await s.invoices.removePayment(payment.id);
    expect(await s.invoices.listPayments(invoice.id)).toEqual([]);
    const afterTrash = (await s.invoices.get(invoice.id))!;
    expect(afterTrash.paidAmount).toBe(0);
    expect(afterTrash.status).toBe("sent");
    const entry = await trashOf(s, "payment", payment.id);
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.snapshot).toEqual(payment);
    await s.trash.restore(entry.id);
    const payments = await s.invoices.listPayments(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toEqual(payment);
    const restored = (await s.invoices.get(invoice.id))!;
    expect(restored.paidAmount).toBe(150000);
    expect(restored.status).toBe("partial");
  });

  it("payroll run: trash and restore round-trip", async () => {
    const s = await freshServices();
    const { t } = await seedBasic(s);
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    await s.payroll.remove(run.id);
    expect(await s.payroll.get(run.id)).toBeUndefined();
    const entry = await trashOf(s, "payrollRun", run.id);
    expect(entry.label).toContain("Budi");
    expect(entry.snapshot).toEqual(run);
    await s.trash.restore(entry.id);
    expect(await s.payroll.get(run.id)).toEqual(run);
  });

  it("starts empty, and removing an already-trashed record is NOT_FOUND", async () => {
    const s = await freshServices();
    expect(await s.trash.list()).toEqual([]);
    const m = await s.members.create(memberInput("Ana"));
    await s.members.remove(m.id);
    await expectCode(s.members.remove(m.id), "NOT_FOUND");
    expect(await s.trash.list()).toHaveLength(1);
  });

  it("restore of an unknown trash entry is NOT_FOUND", async () => {
    const s = await freshServices();
    await expectCode(s.trash.restore("no-such-entry"), "NOT_FOUND");
  });
});

describe("trash: restore conflicts", () => {
  it("enrollment: re-enrolling the same member blocks the restore", async () => {
    const s = await freshServices();
    const { m, c, enrollment } = await seedEnrolled(s);
    await s.courses.removeEnrollment(enrollment.id);
    const entry = await trashOf(s, "enrollment", enrollment.id);
    await s.courses.enroll({ memberId: m.id, courseId: c.id, startDate: "2026-11-09", endDate: null, status: "active", idempotencyKey: createId() });
    await expectCode(s.trash.restore(entry.id), "RESTORE_CONFLICT");
    expect(await s.courses.listEnrollmentsByCourse(c.id)).toHaveLength(1);
    expect((await s.trash.list()).map((e) => e.id)).toContain(entry.id);
  });

  it("session: a new session on the same course and date blocks the restore", async () => {
    const s = await freshServices();
    const { c, t, session } = await seedSession(s);
    await s.attendance.removeSession(session.id);
    const entry = await trashOf(s, "session", session.id);
    await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Replacement", trainerId: t.id, trainerPresent: false, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    await expectCode(s.trash.restore(entry.id), "RESTORE_CONFLICT");
    expect((await s.trash.list()).map((e) => e.id)).toContain(entry.id);
  });

  it("payroll: regenerating the same trainer and period blocks the restore", async () => {
    const s = await freshServices();
    const { t } = await seedBasic(s);
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    await s.payroll.remove(run.id);
    const entry = await trashOf(s, "payrollRun", run.id);
    const again = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    expect(again.id).not.toBe(run.id);
    await expectCode(s.trash.restore(entry.id), "RESTORE_CONFLICT");
    expect(await s.payroll.get(run.id)).toBeUndefined();
  });

  it("invoice: a new invoice reusing the same number blocks the restore", async () => {
    // Fixed clock, same day for both creates: once the first invoice is
    // trashed its number is free, so the second create reuses it.
    const s = await freshServicesWithClock(Date.UTC(2026, 10, 21, 12, 0, 0));
    const { m } = await seedBasic(s);
    const first = await makeInvoice(s, m.id, 400000);
    expect(first.number).toMatch(/^INV-\d{8}-001$/);
    await s.invoices.remove(first.id);
    const entry = await trashOf(s, "invoice", first.id);
    const second = await makeInvoice(s, m.id, 100000);
    expect(second.number).toBe(first.number);
    await expectCode(s.trash.restore(entry.id), "RESTORE_CONFLICT");
    expect(await s.invoices.get(first.id)).toBeUndefined();
    expect((await s.invoices.get(second.id))!.number).toBe(first.number);
  });

  it("payment: permanently deleting its invoice blocks the restore", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const { invoice, payment } = await seedInvoiceWithPayment(s, m.id);
    await s.invoices.removePayment(payment.id);
    const paymentEntry = await trashOf(s, "payment", payment.id);
    await s.invoices.remove(invoice.id);
    const invoiceEntry = await trashOf(s, "invoice", invoice.id);
    await s.trash.deletePermanently(invoiceEntry.id);
    expect(await s.invoices.get(invoice.id)).toBeUndefined();
    await expectCode(s.trash.restore(paymentEntry.id), "RESTORE_CONFLICT");
    expect((await s.trash.list()).map((e) => e.id)).toContain(paymentEntry.id);
    expect(await s.invoices.listPayments(invoice.id)).toEqual([]);
  });

  it("payment: restoring past the invoice total fails (invoice total lowered directly, no service path lowers a total)", async () => {
    // No service call lowers an invoice total: totals derive from line items.
    // To exercise the restore guard, the total is lowered through storage
    // directly, as if an edit had shrunk the invoice after the payment was
    // trashed. The trashed payment (150000) no longer fits in the 100000 total.
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const { invoice, payment } = await seedInvoiceWithPayment(s, m.id, 400000, 150000);
    await s.invoices.removePayment(payment.id);
    const entry = await trashOf(s, "payment", payment.id);
    const current = (await s.invoices.get(invoice.id))!;
    await getStorage().invoices.put({ ...current, total: 100000 });
    expect((await s.invoices.get(invoice.id))!.total).toBe(100000);
    await expectCode(s.trash.restore(entry.id), "RESTORE_CONFLICT");
    expect(await s.invoices.listPayments(invoice.id)).toEqual([]);
    expect((await s.invoices.get(invoice.id))!.paidAmount).toBe(0);
    expect((await s.trash.list()).map((e) => e.id)).toContain(entry.id);
  });
});

describe("trash: retention and purge", () => {
  it("trashDaysRemaining counts whole days left, 0 once expired", () => {
    const t0 = Date.UTC(2026, 10, 21, 12, 0, 0);
    const entry: TrashEntry = { id: "t1", kind: "member", originalId: "m1", label: "Ana", snapshot: {}, related: [], deletedAt: t0 };
    expect(trashDaysRemaining(entry, 7, t0)).toBe(7);
    expect(trashDaysRemaining(entry, 7, t0 + DAY)).toBe(6);
    expect(trashDaysRemaining(entry, 7, t0 + 6 * DAY + 12 * 60 * 60 * 1000)).toBe(1);
    expect(trashDaysRemaining(entry, 7, t0 + 7 * DAY)).toBe(0);
    expect(trashDaysRemaining(entry, 7, t0 + 8 * DAY)).toBe(0);
    expect(trashDaysRemaining(entry, 30, t0 + 8 * DAY)).toBe(22);
  });

  it("retention defaults to 7 days and switches between 7 and 30", async () => {
    const s = await freshServices();
    expect(await s.trash.getRetentionDays()).toBe(7);
    await s.trash.setRetentionDays(30);
    expect(await s.trash.getRetentionDays()).toBe(30);
    await s.trash.setRetentionDays(7);
    expect(await s.trash.getRetentionDays()).toBe(7);
  });

  it("purgeExpired uses the current retention setting and reports how many it removed", async () => {
    const t0 = Date.UTC(2026, 10, 21, 12, 0, 0);
    const s = await freshServicesWithClock(t0);
    const m = await s.members.create(memberInput("Ana"));
    await s.members.remove(m.id);
    const entry = await trashOf(s, "member", m.id);
    expect(entry.deletedAt).toBe(t0);
    // 8 days old: expired under 7 days, still kept under 30.
    await s.trash.setRetentionDays(30);
    expect(await s.trash.purgeExpired(t0 + 8 * DAY)).toBe(0);
    expect(await s.trash.list()).toHaveLength(1);
    await s.trash.setRetentionDays(7);
    expect(await s.trash.purgeExpired(t0 + 8 * DAY)).toBe(1);
    expect(await s.trash.list()).toHaveLength(0);
    // Nothing left to purge.
    expect(await s.trash.purgeExpired(t0 + 40 * DAY)).toBe(0);
  });

  it("empty() permanently deletes every trash entry and leaves live data alone", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const t = await s.trainers.create(trainerInput("Budi"));
    const keeper = await s.members.create(memberInput("Citra"));
    await s.members.remove(m.id);
    await s.trainers.remove(t.id);
    expect(await s.trash.list()).toHaveLength(2);
    await s.trash.empty();
    expect(await s.trash.list()).toHaveLength(0);
    expect(await s.members.get(m.id)).toBeUndefined();
    expect(await s.trainers.get(t.id)).toBeUndefined();
    expect(await s.members.get(keeper.id)).toBeDefined();
  });
});

describe("trash: invoice attachments", () => {
  it("attachments survive trash and restore, and go with a permanent delete", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const invoice = await makeInvoice(s, m.id);
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared: preparedImage() });
    await s.invoices.remove(invoice.id);
    const entry = await trashOf(s, "invoice", invoice.id);
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(1);
    expect(await s.attachments.hasBlob(stored.id)).toBe(true);
    await s.trash.restore(entry.id);
    expect(await s.invoices.get(invoice.id)).toBeDefined();
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(1);
    const blob = await s.attachments.getBlob(stored.id);
    expect(blob).toBeDefined();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    await s.invoices.remove(invoice.id);
    const again = await trashOf(s, "invoice", invoice.id);
    await s.trash.deletePermanently(again.id);
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(0);
    expect(await s.attachments.hasBlob(stored.id)).toBe(false);
  });
});

describe("trash: delete blocked", () => {
  it("member with enrollments or invoices stays live and out of trash", async () => {
    const s = await freshServices();
    const { m, enrollment } = await seedEnrolled(s);
    await expectCode(s.members.remove(m.id), "DELETE_BLOCKED");
    const invoice = await makeInvoice(s, m.id);
    await expectCode(s.members.remove(m.id), "DELETE_BLOCKED");
    expect(await s.members.get(m.id)).toBeDefined();
    expect(await s.trash.list()).toHaveLength(0);
    // Cleanup check: the block is about links, not the member itself.
    expect(enrollment.id).toBeTruthy();
    expect(invoice.id).toBeTruthy();
  });

  it("trainer with only courses can be deleted; trainer with sessions or pay runs stays live and out of trash", async () => {
    const s = await freshServices();
    const { t, c } = await seedBasic(s);
    // A course owns no trainer any more, so the course alone does not block the delete.
    await s.trainers.remove(t.id);
    expect(await s.trainers.get(t.id)).toBeUndefined();
    expect((await s.trash.list()).map((e) => e.originalId)).toContain(t.id);
    expect(await s.courses.get(c.id)).toBeDefined();
    const s2 = await freshServices();
    const trainer = await s2.trainers.create(trainerInput("Dewi"));
    const run = await s2.payroll.generate({ trainerId: trainer.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    await expectCode(s2.trainers.remove(trainer.id), "DELETE_BLOCKED");
    expect(await s2.trainers.get(trainer.id)).toBeDefined();
    expect(await s2.trash.list()).toHaveLength(0);
    expect(run.id).toBeTruthy();
  });

  it("course with enrollments or sessions stays live and out of trash", async () => {
    const s = await freshServices();
    const { c, session } = await seedSession(s);
    await expectCode(s.courses.remove(c.id), "DELETE_BLOCKED");
    expect(await s.courses.get(c.id)).toBeDefined();
    expect(await s.trash.list()).toHaveLength(0);
    expect(session.id).toBeTruthy();
  });

  it("enrollment with invoices stays live and out of trash", async () => {
    const s = await freshServices();
    const { m, enrollment } = await seedEnrolled(s);
    const invoice = await makeInvoice(s, m.id, 100000, enrollment.id);
    await expectCode(s.courses.removeEnrollment(enrollment.id), "DELETE_BLOCKED");
    expect((await s.courses.listEnrollmentsByCourse(enrollment.courseId))).toHaveLength(1);
    expect(await s.trash.list()).toHaveLength(0);
    expect(invoice.id).toBeTruthy();
  });

  it("a paid pay run is a permanent record and cannot be trashed", async () => {
    const s = await freshServices();
    const { t } = await seedBasic(s);
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    await s.payroll.setStatus(run.id, { status: "paid", idempotencyKey: createId() });
    await expectCode(s.payroll.remove(run.id), "DELETE_BLOCKED");
    expect(await s.payroll.get(run.id)).toBeDefined();
    expect(await s.trash.list()).toHaveLength(0);
  });
});

describe("trash: audit log", () => {
  it("trash, restore and permanent delete each write their own audit entry", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const { invoice, payment } = await seedInvoiceWithPayment(s, m.id);
    const run = await s.payroll.generate({ trainerId: (await s.trainers.list())[0].id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    void payment;

    await s.invoices.remove(invoice.id);
    const invoiceEntry = await trashOf(s, "invoice", invoice.id);
    await s.trash.restore(invoiceEntry.id);
    await s.invoices.remove(invoice.id);
    const invoiceEntry2 = await trashOf(s, "invoice", invoice.id);
    await s.trash.deletePermanently(invoiceEntry2.id);
    await s.payroll.remove(run.id);
    const runEntry = await trashOf(s, "payrollRun", run.id);

    const log = await getStorage().audit.all();
    const has = (action: string, entityId: string) => log.some((e) => e.action === action && e.entityId === entityId);
    const hasSuffix = (suffix: string, entityId: string) => log.some((e) => e.action.endsWith(suffix) && e.entityId === entityId);
    expect(has("invoice.trash", invoice.id)).toBe(true);
    expect(has("invoice.restore", invoice.id)).toBe(true);
    expect(has("invoice.delete", invoice.id)).toBe(true);
    // Payroll actions share the "payroll.*" prefix with the "payrollRun" entity.
    expect(hasSuffix(".trash", run.id)).toBe(true);
    expect(runEntry.kind).toBe("payrollRun");

    const member = await s.members.create(memberInput("Dewi"));
    await s.members.remove(member.id);
    const memberEntry = await trashOf(s, "member", member.id);
    await s.trash.restore(memberEntry.id);
    const log2 = await getStorage().audit.all();
    expect(log2.some((e) => e.action === "member.trash" && e.entityId === member.id)).toBe(true);
    expect(log2.some((e) => e.action === "member.restore" && e.entityId === member.id)).toBe(true);
  });
});

describe("trash: backup round-trip", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("trashed entries survive a backup and restore with snapshots intact", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const invoice = await makeInvoice(s, m.id);
    const doomed = await s.members.create(memberInput("Doomed"));
    await s.invoices.remove(invoice.id);
    await s.members.remove(doomed.id);
    const before = await s.trash.list();
    expect(before).toHaveLength(2);
    const invoiceEntry = before.find((e) => e.kind === "invoice")!;
    const memberEntry = before.find((e) => e.kind === "member")!;

    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipSync(created.value.zip);
    expect(Object.keys(files)).toContain("database/trash.ndjson");
    const stores = created.value.manifest.stores as Record<string, { count: number }>;
    expect(stores.trash.count).toBe(2);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, created.value.fileName), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const after = await getServices().trash.list();
    expect(after).toHaveLength(2);
    const byKind = new Map(after.map((e) => [e.kind, e]));
    expect(byKind.get("invoice")!.originalId).toBe(invoice.id);
    expect(byKind.get("invoice")!.label).toBe(invoiceEntry.label);
    expect(byKind.get("invoice")!.snapshot).toEqual(invoiceEntry.snapshot);
    expect(byKind.get("member")!.originalId).toBe(doomed.id);
    expect(byKind.get("member")!.snapshot).toEqual(memberEntry.snapshot);
    // Trashed records stay trashed: nothing leaks back to the live stores.
    expect(await getServices().invoices.get(invoice.id)).toBeUndefined();
    expect(await getServices().members.get(doomed.id)).toBeUndefined();
  });

  it("an old-format v1 backup still restores, with an empty trash bin and 7-day retention", async () => {
    await freshServices();
    const zip = readFileSync("tests/fixtures/olaseena-backup-v1.zip");
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await service.inspect(toFile(zip, "olaseena-backup-v1.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.formatVersion).toBe(1);
    const restored = await service.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name)).toEqual(["Ana"]);
    expect(await getServices().trash.list()).toEqual([]);
    expect(await getServices().trash.getRetentionDays()).toBe(7);
  });
});

describe("trash: restore with missing references", () => {
  it("session restore fails when its attendance member is gone for good", async () => {
    const s = await freshServices();
    const { m, enrollment, session } = await seedSession(s);
    await s.attendance.removeSession(session.id);
    const sessionEntry = await trashOf(s, "session", session.id);
    // Remove the member for good: trash the enrollment, trash the member,
    // then permanently delete the member's trash entry.
    await s.courses.removeEnrollment(enrollment.id);
    await s.members.remove(m.id);
    const memberEntry = await trashOf(s, "member", m.id);
    await s.trash.deletePermanently(memberEntry.id);
    expect(await s.members.get(m.id)).toBeUndefined();
    await expectCode(s.trash.restore(sessionEntry.id), "RESTORE_CONFLICT");
    expect(await s.attendance.getSession(session.id)).toBeUndefined();
    expect((await s.trash.list()).map((e) => e.id)).toContain(sessionEntry.id);
  });

  it("invoice restore fails when its member is gone for good", async () => {
    const s = await freshServices();
    const { m } = await seedBasic(s);
    const invoice = await makeInvoice(s, m.id);
    await s.invoices.remove(invoice.id);
    const invoiceEntry = await trashOf(s, "invoice", invoice.id);
    await s.members.remove(m.id);
    const memberEntry = await trashOf(s, "member", m.id);
    await s.trash.deletePermanently(memberEntry.id);
    await expectCode(s.trash.restore(invoiceEntry.id), "RESTORE_CONFLICT");
    expect(await s.invoices.get(invoice.id)).toBeUndefined();
    expect((await s.trash.list()).map((e) => e.id)).toContain(invoiceEntry.id);
  });

  it("course restore succeeds even when its old trainer is gone for good", async () => {
    const s = await freshServices();
    const { t, c } = await seedBasic(s);
    await s.courses.remove(c.id);
    const courseEntry = await trashOf(s, "course", c.id);
    // The trashed course no longer depends on the trainer at all.
    await s.trainers.remove(t.id);
    const trainerEntry = await trashOf(s, "trainer", t.id);
    await s.trash.deletePermanently(trainerEntry.id);
    await s.trash.restore(courseEntry.id);
    const restored = await s.courses.get(c.id);
    expect(restored).toBeDefined();
    expect(restored).not.toHaveProperty("trainerId");
    expect((await s.trash.list()).map((e) => e.id)).not.toContain(courseEntry.id);
  });
});
