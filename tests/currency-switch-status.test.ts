// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { resetCurrency } from "@/lib/currency";
import { createId } from "@/lib/storage/utils";

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

async function invoiceWithPayments(s: ReturnType<typeof getServices>, memberId: string, total: number, payments: number[]) {
  const invoice = await s.invoices.create({
    memberId,
    enrollmentId: null,
    lineItems: [{ description: "Fee", amount: total }],
    dueDate: "2026-12-01",
    status: "sent",
    idempotencyKey: createId(),
  });
  for (const amount of payments) {
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount, method: "cash", idempotencyKey: createId() });
  }
  return invoice;
}

describe("currency switch re-derives invoice status", () => {
  beforeEach(() => {
    stubRate(0.0000615, 16260.1626);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a fully paid IDR invoice switched to EUR stays Paid with paid equal to total", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await invoiceWithPayments(s, m.id, 100000, [50000, 50000]);
    expect((await s.invoices.get(invoice.id))!.status).toBe("paid");
    await s.currency.switchCurrency("EUR");
    const converted = (await s.invoices.get(invoice.id))!;
    expect(converted.total).toBe(6.15);
    expect(converted.paidAmount).toBe(6.15);
    expect(converted.status).toBe("paid");
  });

  it("three IDR payments that cover the total after conversion reach Paid instead of stranding at Partial", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await invoiceWithPayments(s, m.id, 100000, [33333, 33333, 33333]);
    expect((await s.invoices.get(invoice.id))!.status).toBe("partial");
    await s.currency.switchCurrency("EUR");
    const converted = (await s.invoices.get(invoice.id))!;
    expect(converted.total).toBe(6.15);
    expect(converted.paidAmount).toBe(6.15);
    expect(converted.status).toBe("paid");
  });

  it("a half paid IDR invoice switched to EUR stays Partial and the rest can still be paid", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await invoiceWithPayments(s, m.id, 100000, [50000]);
    await s.currency.switchCurrency("EUR");
    const converted = (await s.invoices.get(invoice.id))!;
    expect(converted.total).toBe(6.15);
    expect(converted.paidAmount).toBe(3.08);
    expect(converted.status).toBe("partial");
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount: 3.07, method: "cash", idempotencyKey: createId() });
    const paid = (await s.invoices.get(invoice.id))!;
    expect(paid.paidAmount).toBe(6.15);
    expect(paid.status).toBe("paid");
  });

  it("a draft invoice switched to EUR stays a draft", async () => {
    const s = await freshServices();
    const m = await s.members.create(memberInput("Ana"));
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "draft",
      idempotencyKey: createId(),
    });
    await s.currency.switchCurrency("EUR");
    const converted = (await s.invoices.get(invoice.id))!;
    expect(converted.total).toBe(6.15);
    expect(converted.paidAmount).toBe(0);
    expect(converted.status).toBe("draft");
  });

  it("switching a EUR invoice back to IDR re-derives its status too", async () => {
    const s = await freshServices();
    // Start in EUR: switch with no data, so no rate is fetched.
    await s.currency.switchCurrency("EUR");
    const m = await s.members.create(memberInput("Ana"));
    const paid = await invoiceWithPayments(s, m.id, 6.15, [3.08, 3.07]);
    expect((await s.invoices.get(paid.id))!.status).toBe("paid");
    const partial = await invoiceWithPayments(s, m.id, 6.15, [2.05]);
    expect((await s.invoices.get(partial.id))!.status).toBe("partial");
    await s.currency.switchCurrency("IDR");
    const paidBack = (await s.invoices.get(paid.id))!;
    expect(paidBack.paidAmount).toBe(paidBack.total);
    expect(paidBack.status).toBe("paid");
    const partialBack = (await s.invoices.get(partial.id))!;
    expect(partialBack.paidAmount).toBeLessThan(partialBack.total);
    expect(partialBack.status).toBe("partial");
  });
});
