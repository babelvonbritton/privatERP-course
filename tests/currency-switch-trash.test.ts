// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServices, resetServices, type Services } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { resetCurrency } from "@/lib/currency";
import { createId } from "@/lib/storage/utils";
import type { TrashEntry } from "@/lib/domain/trash";

async function freshServices() {
  await resetStorage();
  resetServices();
  resetCurrency();
  return getServices();
}

/** The audit's verified rate: 1 IDR = 0.0000615 EUR. */
function stubRate(idrToEur: number, eurToIdr: number) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const frankfurter = url.match(/base=([A-Z]{3})&symbols=([A-Z]{3})/);
      const from = frankfurter?.[1];
      const to = frankfurter?.[2];
      const rate = from === "IDR" && to === "EUR" ? idrToEur : from === "EUR" && to === "IDR" ? eurToIdr : undefined;
      if (rate === undefined) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ base: from, rates: { [to as string]: rate } }) };
    }),
  );
}

const memberInput = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});

async function trashOf(s: Services, kind: TrashEntry["kind"], originalId: string): Promise<TrashEntry> {
  const entries = await s.trash.list();
  const found = entries.find((e) => e.kind === kind && e.originalId === originalId);
  if (!found) throw new Error(`no trash entry for ${kind} ${originalId}`);
  return found;
}

describe("currency switch converts trash snapshots", () => {
  beforeEach(() => {
    stubRate(0.0000615, 16260.1626);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a trashed payment restores in the new currency and the invoice stays consistent", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    for (const amount of [50000, 50000]) {
      await s.invoices.recordPayment({ invoiceId: invoice.id, amount, method: "cash", idempotencyKey: createId() });
    }
    expect((await s.invoices.get(invoice.id))!.status).toBe("paid");
    const [firstPayment] = await s.invoices.listPayments(invoice.id);
    await s.invoices.removePayment(firstPayment.id);
    expect((await s.invoices.get(invoice.id))!.status).toBe("partial");

    await s.currency.switchCurrency("EUR");
    const entry = await trashOf(s, "payment", firstPayment.id);
    expect((entry.snapshot as { amount: number }).amount).toBe(3.08);

    await s.trash.restore(entry.id);
    const payments = await s.invoices.listPayments(invoice.id);
    expect(payments).toHaveLength(2);
    expect(payments.find((p) => p.id === firstPayment.id)!.amount).toBe(3.08);
    const restored = (await s.invoices.get(invoice.id))!;
    expect(restored.total).toBe(6.15);
    expect(restored.paidAmount).toBe(6.15);
    expect(restored.status).toBe("paid");
  });

  it("a trashed invoice with payments restores in the new currency", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [
        { description: "Course fee", amount: 60000 },
        { description: "Book", amount: 40000 },
      ],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount: 60000, method: "cash", idempotencyKey: createId() });
    await s.invoices.remove(invoice.id);

    await s.currency.switchCurrency("EUR");
    const entry = await trashOf(s, "invoice", invoice.id);
    const snapshot = entry.snapshot as { lineItems: { amount: number }[]; total: number; paidAmount: number; status: string };
    expect(snapshot.lineItems.map((i) => i.amount)).toEqual([3.69, 2.46]);
    expect(snapshot.total).toBe(6.15);
    expect(snapshot.paidAmount).toBe(3.69);
    expect(snapshot.status).toBe("partial");
    expect((entry.related as { amount: number }[]).map((p) => p.amount)).toEqual([3.69]);

    await s.trash.restore(entry.id);
    const restored = (await s.invoices.get(invoice.id))!;
    expect(restored.total).toBe(6.15);
    expect(restored.paidAmount).toBe(3.69);
    expect(restored.status).toBe("partial");
    expect((await s.invoices.listPayments(invoice.id)).map((p) => p.amount)).toEqual([3.69]);
  });

  it("trashed pay runs, courses, and trainers convert too", async () => {
    const s = await freshServices();
    const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
    const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
    const t2 = await s.trainers.create({ name: "Citra", email: "citra@example.com", phone: "0812000002", subjects: ["Voice"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
    const c2 = await s.courses.create({ title: "Voice Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Voice"], scheduleWeekdays: [2], status: "active", idempotencyKey: createId() });
    await s.payroll.remove(run.id);
    await s.trainers.remove(t2.id);
    await s.courses.remove(c2.id);

    await s.currency.switchCurrency("EUR");
    expect(((await trashOf(s, "payrollRun", run.id)).snapshot as { ratePerSession: number; total: number }).ratePerSession).toBe(9.23);
    expect(((await trashOf(s, "payrollRun", run.id)).snapshot as { ratePerSession: number; total: number }).total).toBe(9.23);
    expect(((await trashOf(s, "trainer", t2.id)).snapshot as { ratePerSession: number }).ratePerSession).toBe(9.23);
    expect(((await trashOf(s, "course", c2.id)).snapshot as { price: number }).price).toBe(30.75);

    await s.trash.restore((await trashOf(s, "payrollRun", run.id)).id);
    await s.trash.restore((await trashOf(s, "trainer", t2.id)).id);
    await s.trash.restore((await trashOf(s, "course", c2.id)).id);
    expect((await s.payroll.get(run.id))!.total).toBe(9.23);
    expect((await s.trainers.get(t2.id))!.ratePerSession).toBe(9.23);
    expect((await s.courses.get(c2.id))!.price).toBe(30.75);
  });

  it("a switch with only trashed money still converts instead of taking the no-conversion path", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount: 50000, method: "cash", idempotencyKey: createId() });
    await s.invoices.remove(invoice.id);
    expect(await s.currency.hasConvertibleData()).toBe(true);

    const result = await s.currency.switchCurrency("EUR");
    expect(result).toMatchObject({ switched: true, remaining: 9 });
    expect(fetch).toHaveBeenCalled();
    const snapshot = (await trashOf(s, "invoice", invoice.id)).snapshot as { total: number; paidAmount: number; status: string };
    expect(snapshot.total).toBe(6.15);
    expect(snapshot.paidAmount).toBe(3.08);
    expect(snapshot.status).toBe("partial");

    await s.trash.restore((await trashOf(s, "invoice", invoice.id)).id);
    const restored = (await s.invoices.get(invoice.id))!;
    expect(restored.total).toBe(6.15);
    expect(restored.paidAmount).toBe(3.08);
    expect(restored.status).toBe("partial");
  });

  it("a switch with only a trashed member and no money stays on the no-conversion path", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    await s.members.remove(m.id);
    expect(await s.currency.hasConvertibleData()).toBe(false);
    const result = await s.currency.switchCurrency("EUR");
    expect(result).toMatchObject({ from: "IDR", to: "EUR", rate: 1, switched: true, remaining: 10 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await s.trash.list()).map((e) => e.kind)).toEqual(["member"]);
  });
});
