// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BackupService } from "@/lib/backup/BackupService";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { AttachmentRejection, prepareImageFile, scaledDimensions } from "@/lib/attachments/compress";
import type { PreparedAttachment } from "@/lib/attachments/compress";
import { AttachmentLightbox } from "@/components/attachments/AttachmentLightbox";
import type { Attachment } from "@/lib/domain/attachments";
import { Providers } from "./support";

const noop = () => {};

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

async function seedInvoice() {
  const s = await freshServices();
  const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
  const invoice = await s.invoices.create({
    memberId: m.id,
    enrollmentId: null,
    lineItems: [{ description: "Course fee", amount: 500000 }],
    dueDate: "2026-12-01",
    status: "sent",
    paymentMethod: "cash",
    paymentDetails: "",
    idempotencyKey: createId(),
  });
  return { s, m, invoice };
}

function toFile(zip: Uint8Array, name: string): File {
  return new File([zip as BlobPart], name, { type: "application/zip" });
}

/** A tiny valid PNG body; the tests stub decoding, so the bytes only need to be a Blob. */
function pngFile(name = "receipt.png", size = 100): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function stubBitmap(width: number, height: number) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
}

describe("scaledDimensions", () => {
  it("shrinks the longest edge to 1920 and keeps the ratio", () => {
    expect(scaledDimensions(4000, 3000)).toEqual({ width: 1920, height: 1440 });
    expect(scaledDimensions(3000, 4000)).toEqual({ width: 1440, height: 1920 });
    expect(scaledDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(scaledDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("prepareImageFile", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a file that is not an image", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await expect(prepareImageFile(file, file.name)).rejects.toMatchObject({ name: "AttachmentRejection", key: "attachment.notImage" });
  });

  it("keeps a small image byte for byte", async () => {
    stubBitmap(800, 600);
    const file = pngFile("receipt.png", 100);
    const prepared = await prepareImageFile(file, file.name);
    expect(prepared.blob).toBe(file);
    expect(prepared).toMatchObject({ fileName: "receipt.png", mimeType: "image/png", width: 800, height: 600, sizeBytes: 100 });
  });

  it("downscales a large image and re-encodes it as JPEG", async () => {
    stubBitmap(4000, 3000);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const shrunk = new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) {
      cb(shrunk);
    } as unknown as typeof HTMLCanvasElement.prototype.toBlob);
    const prepared = await prepareImageFile(pngFile("photo.png", 5000), "photo.png");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 1440);
    expect(prepared).toMatchObject({ fileName: "photo.jpg", mimeType: "image/jpeg", width: 1920, height: 1440, sizeBytes: 3 });
  });

  it("rejects an image that is still over 4 MB after shrinking", async () => {
    stubBitmap(4000, 3000);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const huge = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) {
      cb(huge);
    } as unknown as typeof HTMLCanvasElement.prototype.toBlob);
    await expect(prepareImageFile(pngFile("noise.png", 100), "noise.png")).rejects.toMatchObject({ key: "attachment.tooLarge" });
  });

  it("reports an unreadable image instead of failing silently", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("bad image"))));
    await expect(prepareImageFile(pngFile(), "receipt.png")).rejects.toMatchObject({ code: "UNEXPECTED" });
  });
});

describe("schema upgrade", () => {
  it("upgrades an existing version 1 database and keeps its data", async () => {
    await resetStorage();
    resetServices();
    // A database written by the previous version: only the version 1 stores exist.
    const legacy = new Dexie("olaseena-db");
    legacy.version(1).stores({
      members: "id, name, email, phone, status, updatedAt",
      settings: "key",
    });
    await legacy.open();
    await legacy.table("members").add({
      id: "member-legacy",
      orgId: "org-owner",
      ownerId: "owner",
      name: "Legacy Ana",
      email: "",
      phone: "",
      notes: "",
      status: "active",
      createdAt: 1000,
      updatedAt: 1000,
      rev: 1,
    });
    await legacy.close();
    // Opening the real database runs the version 6 upgrade: new stores appear, old rows survive.
    const s = getServices();
    await getStorage().init();
    expect(getStorage().schemaVersion).toBe(6);
    expect((await s.members.list()).map((m) => m.name)).toEqual(["Legacy Ana"]);
    expect(await s.attachments.list("invoice", "nothing")).toHaveLength(0);
    const report = await getStorage().snapshots.readAll();
    expect(report.attachments).toEqual([]);
  });
});

describe("AttachmentService", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const prepared = (overrides: Partial<PreparedAttachment> = {}): PreparedAttachment => ({
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    fileName: "receipt.png",
    mimeType: "image/png",
    width: 10,
    height: 10,
    sizeBytes: 4,
    ...overrides,
  });

  it("stores metadata and bytes, lists by invoice, and audits the add", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared: prepared() });
    expect(stored).toMatchObject({ entityType: "invoice", entityId: invoice.id, fileName: "receipt.png", sizeBytes: 4 });
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(1);
    expect(await s.attachments.list("invoice", "someone-else")).toHaveLength(0);
    const blob = await s.attachments.getBlob(stored.id);
    expect(blob).toBeDefined();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await s.attachments.hasBlob(stored.id)).toBe(true);
    const recent = await getStorage().audit.listRecent(10);
    const entry = recent.find((e) => e.action === "attachment.add");
    expect(entry).toMatchObject({ entity: "invoice", entityId: invoice.id, detail: "receipt.png" });
  });

  it("removes metadata and bytes together and audits the removal", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared: prepared() });
    await s.attachments.remove(stored.id);
    expect(await s.attachments.get(stored.id)).toBeUndefined();
    expect(await s.attachments.hasBlob(stored.id)).toBe(false);
    const recent = await getStorage().audit.listRecent(10);
    expect(recent.find((e) => e.action === "attachment.remove")).toMatchObject({ detail: "receipt.png" });
  });

  it("keeps every attachment when its invoice is trashed, and removes them on permanent delete", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared: prepared() });
    await s.invoices.remove(invoice.id);
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(1);
    expect(await s.attachments.hasBlob(stored.id)).toBe(true);
    const entries = await s.trash.list();
    expect(entries).toHaveLength(1);
    await s.trash.deletePermanently(entries[0].id);
    expect(await s.attachments.list("invoice", invoice.id)).toHaveLength(0);
    expect(await s.attachments.hasBlob(stored.id)).toBe(false);
  });

  it("lists blobs as backup assets and writes them back on restore", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared: prepared() });
    const assets = await s.attachments.listBlobs();
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe(`assets/images/${stored.id}.png`);
    expect(assets[0].bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    await s.attachments.remove(stored.id);
    expect(await s.attachments.listBlobs()).toHaveLength(0);
    const written = await s.attachments.writeBlobs(new Map(assets.map((a) => [a.name, a.bytes])), [stored]);
    expect(written).toBe(1);
    expect(await s.attachments.hasBlob(stored.id)).toBe(true);
  });
});

describe("backup with attachments", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const prepared: PreparedAttachment = {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
    fileName: "receipt.png",
    mimeType: "image/png",
    width: 10,
    height: 10,
    sizeBytes: 4,
  };

  it("backs up attachment files as real ZIP entries and restores metadata and bytes", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared });
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.manifest.schemaVersion).toBe(3);
    expect(created.value.manifest.stores.attachments.count).toBe(1);
    const files = unzipSync(created.value.zip);
    expect(files[`assets/images/${stored.id}.png`]).toEqual(new Uint8Array([1, 2, 3, 4]));

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, created.value.fileName), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.missingAssets")).toBe(false);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const rows = await getServices().attachments.list("invoice", invoice.id);
    expect(rows.map((r) => r.id)).toEqual([stored.id]);
    const blob = await getServices().attachments.getBlob(stored.id);
    expect(blob).toBeDefined();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("keeps the metadata row and shows the file as missing when the asset is gone", async () => {
    const { s, invoice } = await seedInvoice();
    const stored = await s.attachments.add({ entityType: "invoice", entityId: invoice.id, prepared });
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = new Map(Object.entries(unzipSync(created.value.zip)));
    files.delete(`assets/images/${stored.id}.png`);
    const stripped = zipSync(Object.fromEntries(files), { level: 6 });

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(stripped, "stripped.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.missingAssets" && w.vars?.count === 1)).toBe(true);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const rows = await getServices().attachments.list("invoice", invoice.id);
    expect(rows.map((r) => r.id)).toEqual([stored.id]);
    expect(await getServices().attachments.getBlob(stored.id)).toBeUndefined();
  });

  it("still restores a schema version 1 backup with no attachments", async () => {
    await freshServices();
    const zip = readFileSync("tests/fixtures/olaseena-backup-v1.zip");
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await service.inspect(toFile(zip, "olaseena-backup-v1.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.formatVersion).toBe(1);
    expect(inspected.value.manifest.schemaVersion).toBe(1);
    expect(inspected.value.data.attachments).toEqual([]);
    const restored = await service.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name)).toEqual(["Ana"]);
    expect(await getServices().attachments.list("invoice", "missing")).toHaveLength(0);
  });
});

describe("AttachmentLightbox", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const attachment: Attachment = {
    id: "att-1",
    entityType: "invoice",
    entityId: "inv-1",
    fileName: "receipt.png",
    mimeType: "image/png",
    sizeBytes: 4,
    width: 10,
    height: 10,
    createdAt: 1000,
  };

  it("zooms in, zooms out, resets, downloads, and deletes behind a confirm", async () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <Providers>
        <AttachmentLightbox open attachment={attachment} blob={blob} onClose={onClose} onDelete={onDelete} />
      </Providers>,
    );
    const img = screen.getByRole("img", { name: "receipt.png" }) as HTMLImageElement;
    expect(img.style.transform).toMatch(/translate\(0px/);
    expect(img.style.transform).toMatch(/scale\(1\)$/);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(img.style.transform).toMatch(/scale\(1\.33\)/);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(img.style.transform).toMatch(/scale\(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(img.style.transform).toMatch(/translate\(0px/);
    expect(img.style.transform).toMatch(/scale\(1\)$/);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(attachment);
  });

  it("shows the missing state when the file bytes are gone", async () => {
    render(
      <Providers>
        <AttachmentLightbox open attachment={attachment} blob={null} onClose={() => {}} onDelete={() => {}} />
      </Providers>,
    );
    expect(screen.getByText("File missing")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "receipt.png" })).toBeNull();
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
