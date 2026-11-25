// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "@/lib/backup/BackupService";
import { BackupValidator } from "@/lib/backup/BackupValidator";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_STORE_NAMES, DB_SCHEMA_VERSION, STORE_TO_FILE } from "@/lib/backup/constants";
import { convert, fetchRate, getCurrency, resetCurrency, setCurrency } from "@/lib/currency";
import { AppError } from "@/lib/errors/AppError";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { formatMoney } from "@/lib/money";

async function freshServices() {
  await resetStorage();
  resetServices();
  resetCurrency();
  return getServices();
}

const RATES: Record<string, number> = {
  "IDR->EUR": 0.00005,
  "EUR->IDR": 20000,
  "IDR->USD": 0.00006,
  "USD->IDR": 16666.67,
  "EUR->USD": 1.08,
  "USD->EUR": 0.92,
};

function stubFetch() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const frankfurter = url.match(/base=([A-Z]{3})&symbols=([A-Z]{3})/);
      const fallback = url.match(/\/latest\/([A-Z]{3})$/);
      const from = frankfurter?.[1] ?? fallback?.[1];
      const to = frankfurter?.[2];
      if (!from) return { ok: false, json: async () => ({}) };
      if (to) {
        const rate = RATES[`${from}->${to}`];
        return rate === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ base: from, rates: { [to]: rate } }) };
      }
      const rates: Record<string, number> = {};
      for (const [key, value] of Object.entries(RATES)) {
        const [b, t] = key.split("->");
        if (b === from) rates[t] = value;
      }
      return { ok: true, json: async () => ({ base: from, rates }) };
    }),
  );
}

async function seed() {
  const s = await freshServices();
  const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
  const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
  const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, capacity: 10, trainerId: t.id, scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
  const inv = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Course fee", amount: 500000 }, { description: "Book", amount: 75000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
  await s.invoices.recordPayment({ invoiceId: inv.id, amount: 150000, method: "transfer", idempotencyKey: createId() });
  await s.attendance.createSession({ courseId: c.id, date: "2026-11-10", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
  const run = await s.payroll.generate({ trainerId: t.id, periodStart: "2026-11-01", periodEnd: "2026-11-30", idempotencyKey: createId() });
  return { s, m, t, c, inv, run };
}

function toFile(zip: Uint8Array, name: string): File {
  return new File([zip as BlobPart], name, { type: "application/zip" });
}

const noop = () => {};

describe("currency conversion math", () => {
  beforeEach(() => {
    resetCurrency();
  });

  it("converts IDR to EUR with two decimals", () => {
    expect(convert(1000000, 0.00005, "EUR")).toBe(50);
    expect(convert(100000, 0.000049818, "EUR")).toBe(4.98);
    expect(convert(123456, 0.00005, "EUR")).toBe(6.17);
  });

  it("converts EUR to IDR as whole rupiah", () => {
    expect(convert(50, 20000, "IDR")).toBe(1000000);
    expect(convert(4.98, 20000, "IDR")).toBe(99600);
  });

  it("round-trip drift stays small and is only rounding", () => {
    const eur = convert(100001, 0.00005, "EUR");
    expect(eur).toBe(5);
    const back = convert(eur, 20000, "IDR");
    expect(back).toBe(100000);
    expect(100001 - back).toBe(1);
  });

  it("formatMoney follows the current currency", () => {
    setCurrency("EUR");
    expect(formatMoney(50, "en-US")).toContain("50.00");
    expect(formatMoney(150000, "en-US", "IDR")).toContain("150,000");
    expect(getCurrency()).toBe("EUR");
  });
});

describe("currency switch", () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("converts every stored amount and keeps totals consistent", async () => {
    const { s, inv, run } = await seed();
    const result = await s.currency.switchCurrency("EUR");
    expect(result).toMatchObject({ from: "IDR", to: "EUR", rate: 0.00005, switched: true, remaining: 9 });
    const invoice = (await s.invoices.get(inv.id))!;
    expect(invoice.lineItems.map((i) => i.amount)).toEqual([25, 3.75]);
    expect(invoice.total).toBe(28.75);
    expect(invoice.paidAmount).toBe(7.5);
    const payments = await s.invoices.listPayments(inv.id);
    expect(payments.map((p) => p.amount)).toEqual([7.5]);
    expect((await s.courses.get((await s.courses.list())[0].id))!.price).toBe(25);
    expect((await s.trainers.list())[0].ratePerSession).toBe(7.5);
    const payroll = (await s.payroll.get(run.id))!;
    expect(payroll.ratePerSession).toBe(7.5);
    expect(payroll.total).toBe(7.5);
    expect(payroll.sessionCount).toBe(1);
    expect(getStorage().preferences.get().currency).toBe("EUR");
    expect(getCurrency()).toBe("EUR");
    const audit = await getStorage().audit.listRecent(5);
    expect(audit.some((a) => a.action === "currency.switch" && a.detail.includes("IDR to EUR"))).toBe(true);
  });

  it("accepts two decimal places for EUR amounts and keeps IDR whole", async () => {
    const { s, m, t, c } = await seed();
    await s.currency.switchCurrency("EUR");

    await expect(s.courses.update(c.id, { price: 25.751, idempotencyKey: createId() })).rejects.toThrow();
    await s.trainers.update(t.id, { ratePerSession: 7.25, idempotencyKey: createId() });
    await s.courses.update(c.id, { price: 25.75, idempotencyKey: createId() });
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Course fee", amount: 10.25 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount: 1.25, method: "cash", idempotencyKey: createId() });

    expect((await s.trainers.get(t.id))?.ratePerSession).toBe(7.25);
    expect((await s.courses.get(c.id))?.price).toBe(25.75);
    expect((await s.invoices.get(invoice.id))?.total).toBe(10.25);
    expect((await s.invoices.get(invoice.id))?.paidAmount).toBe(1.25);

    await s.currency.switchCurrency("IDR");
    await expect(s.courses.update(c.id, { price: 25.75, idempotencyKey: createId() })).rejects.toThrow();
  });

  it("switching to the current currency is a no-op and fetches nothing", async () => {
    const { s } = await seed();
    const result = await s.currency.switchCurrency("IDR");
    expect(result.switched).toBe(false);
    expect(result.remaining).toBe(10);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("switch with an empty database fetches nothing, uses no daily switch, and changes the currency", async () => {
    const s = await freshServices();
    expect(await s.currency.hasConvertibleData()).toBe(false);
    const result = await s.currency.switchCurrency("EUR");
    expect(result).toMatchObject({ from: "IDR", to: "EUR", rate: 1, switched: true, remaining: 10 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await s.currency.remainingSwitches()).toBe(10);
    expect(getStorage().preferences.get().currency).toBe("EUR");
    expect(getCurrency()).toBe("EUR");
    const audit = await getStorage().audit.listRecent(5);
    const entry = audit.find((a) => a.action === "currency.switch");
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain("IDR to EUR");
    expect(entry!.detail).toContain("no conversion");
    expect(entry!.detail).not.toContain("rate");
  });

  it("switch with seeded data fetches and uses one daily switch", async () => {
    const { s } = await seed();
    expect(await s.currency.hasConvertibleData()).toBe(true);
    const result = await s.currency.switchCurrency("EUR");
    expect(result.switched).toBe(true);
    expect(fetch).toHaveBeenCalled();
    expect(await s.currency.remainingSwitches()).toBe(9);
  });

  it("hasConvertibleData turns true once a single amount-bearing record exists", async () => {
    const s = await freshServices();
    expect(await s.currency.hasConvertibleData()).toBe(false);
    await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
    expect(await s.currency.hasConvertibleData()).toBe(true);
  });

  it("allows 10 switches a day and blocks the 11th", async () => {
    const { s } = await seed();
    for (let i = 0; i < 10; i++) {
      const to = i % 2 === 0 ? "EUR" : "IDR";
      const result = await s.currency.switchCurrency(to as "EUR" | "IDR");
      expect(result.switched).toBe(true);
    }
    expect(await s.currency.remainingSwitches()).toBe(0);
    let caught: unknown;
    try {
      await s.currency.switchCurrency("EUR");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("CURRENCY_LIMIT_REACHED");
  });

  it("a failed fetch leaves data and currency untouched", async () => {
    const { s, inv } = await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    let caught: unknown;
    try {
      await s.currency.switchCurrency("EUR");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("CURRENCY_FETCH_FAILED");
    expect((await s.invoices.get(inv.id))!.total).toBe(575000);
    expect(getStorage().preferences.get().currency).toBe("IDR");
    expect(getCurrency()).toBe("IDR");
  });

  it("fetchRate tries the fallback when the primary source fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("frankfurter")) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ base: "IDR", rates: { EUR: 0.00005 } }) };
      }),
    );
    await expect(fetchRate("IDR", "EUR")).resolves.toBe(0.00005);
  });
});

describe("currency in backups", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rawManifest(currency: unknown): Record<string, unknown> {
    const stores: Record<string, unknown> = {};
    for (const name of BACKUP_STORE_NAMES) stores[name] = { count: 0, sha256: "0".repeat(64) };
    const manifest: Record<string, unknown> = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      kind: "backup",
      app: { name: "Olaseena", version: "0.2.0" },
      createdAt: "2026-11-20T00:00:00.000Z",
      createdAtMs: 1795132800000,
      stores,
      files: BACKUP_STORE_NAMES.map((name) => ({ name: STORE_TO_FILE[name], bytes: 0, sha256: "0".repeat(64) })),
    };
    if (currency !== undefined) manifest.currency = currency;
    return manifest;
  }

  it("a manifest without a currency validates to IDR", () => {
    expect(BackupValidator.validateManifest(rawManifest(undefined)).currency).toBe("IDR");
    expect(BackupValidator.validateManifest(rawManifest("EUR")).currency).toBe("EUR");
  });

  it("an invalid currency in the manifest is rejected", () => {
    expect(() => BackupValidator.validateManifest(rawManifest("JPY"))).toThrowError(AppError);
  });

  it("a backup carries its currency and a restore adopts it without converting amounts", async () => {
    const { s, inv } = await seed();
    await getStorage().preferences.set("currency", "EUR");
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.manifest.currency).toBe("EUR");

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, created.value.fileName), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.currency).toBe("EUR");
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect(getStorage().preferences.get().currency).toBe("EUR");
    expect(getCurrency()).toBe("EUR");
    expect((await getServices().invoices.get(inv.id))!.total).toBe(575000);
  });

  it("a backup validates decimal amounts stored in EUR", async () => {
    const { s } = await seed();
    await s.currency.switchCurrency("EUR");
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
  });
});
