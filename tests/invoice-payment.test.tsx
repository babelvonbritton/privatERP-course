// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { InvoicesScreen } from "@/components/screens/InvoicesScreen";
import { paymentDetailsOf, paymentMethodOf, paymentMethodValue } from "@/lib/invoicePayment";
import { resetCurrency, setCurrency } from "@/lib/currency";
import type { Invoice } from "@/lib/domain/types";
import { Providers } from "./support";

afterEach(() => {
  cleanup();
  resetCurrency();
});

/** Radix Select relies on pointer capture and scrolling, which jsdom does not implement. */
function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

/** Opens a Radix Select by its accessible name and picks an option. */
async function pickSelect(label: string, option: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

/** A v0.1.x row: stored before the payment fields existed, so they are absent. */
function legacyInvoice(memberId: string, overrides: Partial<Invoice> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: createId(),
    orgId: "org-owner",
    ownerId: "owner",
    createdAt: new Date("2026-11-20T00:00:00").getTime(),
    updatedAt: new Date("2026-11-20T00:00:00").getTime(),
    rev: 1,
    number: "INV-20261120-001",
    memberId,
    enrollmentId: null,
    lineItems: [{ description: "Course fee", amount: 500000 }],
    total: 500000,
    paidAmount: 0,
    dueDate: "2026-12-01",
    status: "sent",
  };
  return { ...row, ...overrides };
}

describe("paymentMethodOf / paymentDetailsOf", () => {
  it("defaults a legacy invoice without the fields to cash with no details", () => {
    expect(paymentMethodOf({})).toBe("cash");
    expect(paymentMethodOf(null)).toBe("cash");
    expect(paymentMethodOf(undefined)).toBe("cash");
    expect(paymentMethodOf({ paymentMethod: undefined })).toBe("cash");
    expect(paymentDetailsOf({})).toBe("");
    expect(paymentDetailsOf(null)).toBe("");
    expect(paymentDetailsOf({ paymentDetails: undefined })).toBe("");
  });

  it("keeps a stored method and details, and rejects an unknown method", () => {
    expect(paymentMethodOf({ paymentMethod: "transfer" })).toBe("transfer");
    expect(paymentMethodOf({ paymentMethod: "other" })).toBe("other");
    expect(paymentMethodOf({ paymentMethod: "cheque" })).toBe("cash");
    expect(paymentMethodValue("transfer")).toBe("transfer");
    expect(paymentMethodValue(undefined)).toBe("cash");
    expect(paymentDetailsOf({ paymentDetails: "BCA 1234567890" })).toBe("BCA 1234567890");
  });
});

describe("InvoiceDocument with a legacy invoice", () => {
  it("shows no payment block and no method.undefined text", () => {
    const legacy = legacyInvoice("member-1") as unknown as Invoice;
    render(
      <Providers>
        <InvoiceDocument invoice={legacy} memberName="Ana" />
      </Providers>,
    );
    expect(screen.queryByTestId("invoice-payment-block")).toBeNull();
    expect(document.body.textContent).not.toContain("method.undefined");
    expect(screen.getByText("INV-20261120-001")).toBeTruthy();
  });
});

describe("legacy invoice through the services", () => {
  it("a stored legacy row really has no payment fields until it is saved", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const row = legacyInvoice(m.id);
    await getStorage().invoices.put(row as unknown as Invoice);
    const stored = (await s.invoices.get(row.id as string)) as unknown as Record<string, unknown>;
    expect(stored.paymentMethod).toBeUndefined();
    expect(stored.paymentDetails).toBeUndefined();
    const updated = await s.invoices.update(row.id as string, { dueDate: "2026-12-02", idempotencyKey: createId() });
    expect(updated.paymentMethod).toBe("cash");
    expect(updated.paymentDetails).toBe("");
    const storedAfter = await s.invoices.get(row.id as string);
    expect(storedAfter?.paymentMethod).toBe("cash");
    expect(storedAfter?.paymentDetails).toBe("");
  });

  it("update writes transfer details onto a legacy invoice", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const row = legacyInvoice(m.id);
    await getStorage().invoices.put(row as unknown as Invoice);
    const updated = await s.invoices.update(row.id as string, { paymentMethod: "transfer", paymentDetails: "BCA 1234567890", idempotencyKey: createId() });
    expect(updated.paymentMethod).toBe("transfer");
    expect(updated.paymentDetails).toBe("BCA 1234567890");
  });

  it("recording a payment sets the invoice method to the payment method", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const row = legacyInvoice(m.id);
    await getStorage().invoices.put(row as unknown as Invoice);
    await s.invoices.recordPayment({ invoiceId: row.id as string, amount: 150000, method: "transfer", idempotencyKey: createId() });
    let current = (await s.invoices.get(row.id as string))!;
    expect(current.paymentMethod).toBe("transfer");
    expect(current.paidAmount).toBe(150000);
    expect(current.status).toBe("partial");
    expect(current.paymentDetails).toBeUndefined();
    await s.invoices.recordPayment({ invoiceId: row.id as string, amount: 350000, method: "cash", idempotencyKey: createId() });
    current = (await s.invoices.get(row.id as string))!;
    expect(current.paymentMethod).toBe("cash");
    expect(current.paidAmount).toBe(500000);
    expect(current.status).toBe("paid");
  });

  it("removing a payment leaves the invoice method alone", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const row = legacyInvoice(m.id);
    await getStorage().invoices.put(row as unknown as Invoice);
    const payment = await s.invoices.recordPayment({ invoiceId: row.id as string, amount: 150000, method: "transfer", idempotencyKey: createId() });
    await s.invoices.removePayment(payment.id);
    const current = (await s.invoices.get(row.id as string))!;
    expect(current.paymentMethod).toBe("transfer");
    expect(current.paidAmount).toBe(0);
    expect(current.status).toBe("sent");
  });
});

describe("InvoicesScreen with a legacy invoice", () => {
  it("detail view shows Cash, the edit form starts at cash, and saving transfer with details persists", async () => {
    stubRadix();
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const row = legacyInvoice(m.id);
    await getStorage().invoices.put(row as unknown as Invoice);

    render(
      <Providers>
        <InvoicesScreen navigate={() => {}} />
      </Providers>,
    );
    await screen.findByText("INV-20261120-001");
    fireEvent.click(screen.getByText("INV-20261120-001"));
    await screen.findByRole("button", { name: "Edit invoice" });
    expect(screen.getAllByText("Cash").length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).not.toContain("method.undefined");
    expect(screen.queryByText("Payment details")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit invoice" }));
    const trigger = await screen.findByRole("combobox", { name: "Payment method" });
    expect(trigger.textContent).toContain("Cash");
    expect(screen.queryByLabelText("Payment details")).toBeNull();

    await pickSelect("Payment method", "Bank transfer");
    const detailsInput = await screen.findByLabelText("Payment details");
    fireEvent.change(detailsInput, { target: { value: "BCA 1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Bank transfer");
    expect(document.body.textContent).not.toContain("method.undefined");
    const stored = await s.invoices.get(row.id as string);
    expect(stored?.paymentMethod).toBe("transfer");
    expect(stored?.paymentDetails).toBe("BCA 1234567890");
  }, 20000);
});

describe("create invoice form fills charges from the course", () => {
  async function seedCourses() {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 100000, status: "active", idempotencyKey: createId() });
    const piano = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, capacity: 10, trainerId: t.id, scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
    const guitar = await s.courses.create({ title: "Guitar Basics", description: "", level: "Beginner", price: 300000, capacity: 10, trainerId: t.id, scheduleWeekdays: [2], status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: piano.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() });
    await s.courses.enroll({ memberId: m.id, courseId: guitar.id, startDate: "2026-11-01", endDate: null, status: "active", idempotencyKey: createId() });
    return { s, m, piano, guitar };
  }

  async function openCreate() {
    render(
      <Providers>
        <InvoicesScreen navigate={() => {}} />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New invoice" }));
    await screen.findByText("Charges");
  }

  it("picking a course fills the first charge, changing it refreshes only that charge, clearing it removes only that charge", async () => {
    stubRadix();
    await seedCourses();
    await openCreate();
    await pickSelect("Member", "Ana");
    await pickSelect("Course", "Piano Basics");
    await screen.findByDisplayValue("Piano Basics");
    expect((screen.getAllByLabelText("Amount")[0] as HTMLInputElement).value).toBe("500000");
    expect(screen.getByText("IDR 500,000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add charge" }));
    const descriptions = screen.getAllByLabelText("Description");
    const amounts = screen.getAllByLabelText("Amount");
    fireEvent.change(descriptions[1], { target: { value: "Book" } });
    fireEvent.change(amounts[1], { target: { value: "75000" } });
    await screen.findByText("IDR 575,000");

    await pickSelect("Course", "Guitar Basics");
    await screen.findByDisplayValue("Guitar Basics");
    expect((screen.getAllByLabelText("Amount")[0] as HTMLInputElement).value).toBe("300000");
    expect((screen.getAllByLabelText("Description")[1] as HTMLInputElement).value).toBe("Book");
    expect((screen.getAllByLabelText("Amount")[1] as HTMLInputElement).value).toBe("75000");
    expect(screen.getByText("IDR 375,000")).toBeTruthy();

    await pickSelect("Course", "Empty");
    await screen.findByText("IDR 75,000");
    expect(screen.getAllByLabelText("Description")).toHaveLength(1);
    expect((screen.getAllByLabelText("Description")[0] as HTMLInputElement).value).toBe("Book");
    expect(screen.queryByDisplayValue("Guitar Basics")).toBeNull();
  }, 20000);

  it("lines the user typed before picking a course are left alone", async () => {
    stubRadix();
    await seedCourses();
    await openCreate();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Custom" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
    await pickSelect("Member", "Ana");
    await pickSelect("Course", "Piano Basics");
    await screen.findByText("IDR 100,000");
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Custom");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("100000");
    expect(screen.queryByDisplayValue("Piano Basics")).toBeNull();
  }, 20000);

  it("editing the filled charge by hand stops it following course changes", async () => {
    stubRadix();
    await seedCourses();
    await openCreate();
    await pickSelect("Member", "Ana");
    await pickSelect("Course", "Piano Basics");
    await screen.findByDisplayValue("Piano Basics");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "450000" } });
    await pickSelect("Course", "Guitar Basics");
    await screen.findByText("IDR 450,000");
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Piano Basics");
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("450000");
  }, 20000);

  it("the amount label follows the current currency", async () => {
    stubRadix();
    setCurrency("EUR");
    await seedCourses();
    await openCreate();
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(screen.queryByText("IDR")).toBeNull();
    expect(screen.getByText("Charges")).toBeTruthy();
    expect(screen.getByText("Add charge")).toBeTruthy();
  }, 20000);
});
