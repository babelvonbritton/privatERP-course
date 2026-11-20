// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BackupValidator } from "@/lib/backup/BackupValidator";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { pdfPageLayout } from "@/lib/invoiceExport";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import type { Invoice } from "@/lib/domain/types";
import { Providers } from "./support";

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: createId(),
    orgId: "org-owner",
    ownerId: "owner",
    createdAt: new Date("2026-11-20T00:00:00").getTime(),
    updatedAt: new Date("2026-11-20T00:00:00").getTime(),
    rev: 1,
    number: "INV-20261120-001",
    memberId: "member-1",
    enrollmentId: null,
    lineItems: [{ description: "Course fee", amount: 500000 }],
    total: 500000,
    paidAmount: 0,
    dueDate: "2026-12-01",
    status: "sent",
    paymentMethod: "cash",
    paymentDetails: "",
    ...overrides,
  };
}

describe("invoice payment fields", () => {
  it("create defaults to cash with no details, and the values persist", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const created = await s.invoices.create({ memberId: m.id, enrollmentId: null, lineItems: [{ description: "Fee", amount: 100000 }], dueDate: "2026-12-01", status: "sent", idempotencyKey: createId() });
    expect(created.paymentMethod).toBe("cash");
    expect(created.paymentDetails).toBe("");
    const stored = await s.invoices.get(created.id);
    expect(stored?.paymentMethod).toBe("cash");
    expect(stored?.paymentDetails).toBe("");
  });

  it("create stores transfer details, and update changes them", async () => {
    const s = await freshServices();
    const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const created = await s.invoices.create({
      memberId: m.id,
      enrollmentId: null,
      lineItems: [{ description: "Fee", amount: 100000 }],
      dueDate: "2026-12-01",
      status: "sent",
      paymentMethod: "transfer",
      paymentDetails: "BCA 1234567890",
      idempotencyKey: createId(),
    });
    expect(created.paymentMethod).toBe("transfer");
    expect(created.paymentDetails).toBe("BCA 1234567890");
    const updated = await s.invoices.update(created.id, { paymentMethod: "other", paymentDetails: "E-wallet 0812000000", idempotencyKey: createId() });
    expect(updated.paymentMethod).toBe("other");
    expect(updated.paymentDetails).toBe("E-wallet 0812000000");
    const stored = await s.invoices.get(created.id);
    expect(stored?.paymentMethod).toBe("other");
  });

  it("an old backup invoice without the new fields restores with the defaults", () => {
    const raw = {
      members: [{ id: "member-1", orgId: "org-owner", ownerId: "owner", name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", createdAt: 1000, updatedAt: 1000, rev: 1 }],
      trainers: [],
      courses: [],
      enrollments: [],
      sessions: [],
      attendance: [],
      invoices: [
        {
          id: "invoice-1",
          orgId: "org-owner",
          ownerId: "owner",
          number: "INV-20261120-001",
          memberId: "member-1",
          enrollmentId: null,
          lineItems: [{ description: "Course fee", amount: 500000 }],
          total: 500000,
          paidAmount: 0,
          dueDate: "2026-12-01",
          status: "sent",
          createdAt: 1000,
          updatedAt: 1000,
          rev: 1,
        },
      ],
      payments: [],
      payrollRuns: [],
      auditLog: [],
      writeKeys: [],
      settings: [],
    };
    const result = BackupValidator.validateData(raw);
    expect(result.data.invoices).toHaveLength(1);
    expect(result.data.invoices[0].paymentMethod).toBe("cash");
    expect(result.data.invoices[0].paymentDetails).toBe("");
  });
});

describe("InvoiceDocument", () => {
  it("shows the payment block for transfer, and hides it for cash", () => {
    const transfer = invoice({ paymentMethod: "transfer", paymentDetails: "BCA 1234567890" });
    const { rerender } = render(
      <Providers>
        <InvoiceDocument invoice={transfer} memberName="Ana" />
      </Providers>,
    );
    expect(screen.getByTestId("invoice-payment-block")).toBeTruthy();
    expect(screen.getByText("BCA 1234567890")).toBeTruthy();
    expect(screen.getByText("INV-20261120-001")).toBeTruthy();

    rerender(
      <Providers>
        <InvoiceDocument invoice={invoice()} memberName="Ana" />
      </Providers>,
    );
    expect(screen.queryByTestId("invoice-payment-block")).toBeNull();
  });

  it("includes attached images in the printable document", async () => {
    render(
      <Providers>
        <InvoiceDocument
          invoice={invoice()}
          memberName="Ana"
          attachments={[{ id: "attachment-1", fileName: "receipt.png", blob: new Blob(["image"], { type: "image/png" }) }]}
        />
      </Providers>,
    );

    expect(screen.getByTestId("invoice-attachments")).toBeTruthy();
    expect(await screen.findByAltText("receipt.png")).toBeTruthy();
    expect(screen.getByAltText("receipt.png").getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("pdfPageLayout", () => {
  it("fits a short invoice on one page and spills a long one onto more", () => {
    expect(pdfPageLayout(1280, 900).pageCount).toBe(1);
    const long = pdfPageLayout(1280, 3000);
    expect(long.scaledWidth).toBe(210);
    expect(long.pageCount).toBeGreaterThan(1);
    expect(long.scaledHeight).toBeCloseTo((3000 * 210) / 1280, 5);
  });
});
