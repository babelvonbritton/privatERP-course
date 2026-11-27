// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { todayIso } from "@/lib/dates";
import { dateOf, dayEndMs, dayStartMs, deviceTimezone, getTimezone, isTimezone, resetTimezone, setTimezone, zoneOffsetLabel } from "@/lib/timezone";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

const WIB_MORNING = Date.parse("2026-11-25T19:30:00Z");

afterEach(() => {
  resetTimezone();
});

describe("timezone helpers", () => {
  it("a 02:30 WIB timestamp is 26 Nov under Asia/Jakarta and 25 Nov under UTC", () => {
    expect(dateOf(WIB_MORNING, "Asia/Jakarta")).toBe("2026-11-26");
    expect(dateOf(WIB_MORNING, "UTC")).toBe("2026-11-25");
  });

  it("today follows the chosen zone", () => {
    setTimezone("Asia/Jakarta");
    expect(todayIso(new Date(WIB_MORNING))).toBe("2026-11-26");
    setTimezone("UTC");
    expect(todayIso(new Date(WIB_MORNING))).toBe("2026-11-25");
  });

  it("the default zone is the device zone", () => {
    expect(getTimezone()).toBe(deviceTimezone());
  });

  it("the picker list always includes UTC", async () => {
    const { timezones } = await import("@/lib/timezone");
    expect(timezones()).toContain("UTC");
  });

  it("only real IANA zones are accepted", () => {
    expect(isTimezone("Asia/Jakarta")).toBe(true);
    expect(isTimezone("UTC")).toBe(true);
    expect(isTimezone("Not/AZone")).toBe(false);
    expect(isTimezone("")).toBe(false);
    expect(isTimezone(7)).toBe(false);
  });

  it("labels a zone with its UTC offset", () => {
    expect(zoneOffsetLabel("Asia/Jakarta", WIB_MORNING)).toBe("UTC+07:00");
    expect(zoneOffsetLabel("UTC", WIB_MORNING)).toBe("UTC+00:00");
  });

  it("a day starts at midnight in the zone, not midnight UTC", () => {
    expect(dayStartMs("2026-11-26", "Asia/Jakarta")).toBe(Date.parse("2026-11-25T17:00:00Z"));
    expect(dayStartMs("2026-11-26", "UTC")).toBe(Date.parse("2026-11-26T00:00:00Z"));
  });

  it("a day ends at the last millisecond of the day in the zone", () => {
    expect(dayEndMs("2026-11-26", "Asia/Jakarta")).toBe(Date.parse("2026-11-26T16:59:59.999Z"));
    expect(dayEndMs("2026-11-26", "UTC")).toBe(Date.parse("2026-11-26T23:59:59.999Z"));
  });
});

describe("timezone preference", () => {
  it("saves and loads the picked zone", async () => {
    await resetStorage();
    await getStorage().preferences.set("timezone", "Asia/Jakarta");
    const { preferences } = await getStorage().preferences.load();
    expect(preferences.timezone).toBe("Asia/Jakarta");
  });

  it("an invalid stored zone repairs to the device zone", async () => {
    await resetStorage();
    await getStorage().settings.write("pref.timezone", "Not/AZone");
    const { preferences, repaired } = await getStorage().preferences.load();
    expect(preferences.timezone).toBe(deviceTimezone());
    expect(repaired).toContain("pref.timezone");
  });

  it("rejects an invalid zone on save", async () => {
    await resetStorage();
    await expect(getStorage().preferences.set("timezone", "Not/AZone")).rejects.toThrow();
  });
});

describe("timezone in the services", () => {
  it("an invoice created at 02:30 WIB carries the 26 Nov number prefix under Asia/Jakarta", async () => {
    setTimezone("Asia/Jakarta");
    await resetStorage();
    resetServices();
    const { Services } = await import("@/lib/domain/services");
    const { OWNER_ACTOR } = await import("@/lib/domain/types");
    const s = new Services(getStorage(), OWNER_ACTOR, () => WIB_MORNING);
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    expect(invoice.number.startsWith("INV-20261126-")).toBe(true);
  });

  it("a payment made at 02:00 WIB on 1 Nov counts in November revenue under Asia/Jakarta", async () => {
    setTimezone("Asia/Jakarta");
    await resetStorage();
    resetServices();
    const { Services } = await import("@/lib/domain/services");
    const { OWNER_ACTOR } = await import("@/lib/domain/types");
    const at = Date.parse("2026-10-31T19:00:00Z");
    const s = new Services(getStorage(), OWNER_ACTOR, () => at);
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const invoice = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "sent",
      idempotencyKey: createId(),
    });
    await s.invoices.recordPayment({ invoiceId: invoice.id, amount: 100000, method: "cash", idempotencyKey: createId() });
    expect(todayIso(new Date(at))).toBe("2026-11-01");
    const data = await s.dashboard.get(todayIso(new Date(at)));
    expect(data.revenueCollectedThisMonth).toBe(100000);
  });
});
