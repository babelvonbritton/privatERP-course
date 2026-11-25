// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "@/lib/backup/BackupService";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

const noop = () => {};

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

async function seed() {
  const s = await freshServices();
  const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
  const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
  const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, capacity: 10, trainerId: t.id, scheduleWeekdays: [1], scheduleTime: "09:00", status: "active", idempotencyKey: createId() });
  return { s, m, t, c };
}

function toFile(zip: Uint8Array, name: string): File {
  return new File([zip as BlobPart], name, { type: "application/zip" });
}

describe("backup round-trip", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("creates a backup, restores it into an empty database, and the records come back", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.fileName.startsWith("olaseena-backup-")).toBe(true);
    expect(created.value.zip.length).toBeGreaterThan(0);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, created.value.fileName), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.merge.totals.new).toBeGreaterThan(0);

    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const after = getServices();
    expect((await after.members.list()).map((m) => m.name)).toEqual(["Ana"]);
    expect((await after.trainers.list()).map((t) => t.name)).toEqual(["Budi"]);
    expect((await after.courses.list()).map((c) => c.title)).toEqual(["Piano Basics"]);
  });

  it("a differing record can be replaced or kept, by choice", async () => {
    const { s, m } = await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const file = toFile(created.value.zip, created.value.fileName);

    // Change the name after the backup, then restore with "replace": the backup wins.
    await s.members.update(m.id, { name: "Ana Changed", idempotencyKey: createId() });
    const inspected = await service.inspect(file, noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const differs = inspected.value.merge.entries.filter((e) => e.status === "differs");
    expect(differs).toHaveLength(1);
    const replaced = await service.restore(inspected.value, { safetyBackup: false, decisions: new Map([[differs[0].key, "replace"]]), onRestored: async () => {} }, noop);
    expect(replaced.ok).toBe(true);
    expect((await s.members.get(m.id))?.name).toBe("Ana");

    // Change it again, then restore with "skip": the current name stays.
    await s.members.update(m.id, { name: "Ana Changed", idempotencyKey: createId() });
    const inspected2 = await service.inspect(file, noop);
    expect(inspected2.ok).toBe(true);
    if (!inspected2.ok) return;
    const kept = await service.restore(inspected2.value, { safetyBackup: false, decisions: new Map([[differs[0].key, "skip"]]), onRestored: async () => {} }, noop);
    expect(kept.ok).toBe(true);
    expect((await s.members.get(m.id))?.name).toBe("Ana Changed");
  });

  it("an encrypted backup needs its passphrase, and restores with it", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop, "backup", "correct horse battery staple");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const file = toFile(created.value.zip, created.value.fileName);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const wrong = await freshService.inspect(file, noop, "wrong passphrase");
    expect(wrong.ok).toBe(false);

    const right = await freshService.inspect(file, noop, "correct horse battery staple");
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    const restored = await freshService.restore(right.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name)).toEqual(["Ana"]);
  });

  it("a damaged archive is refused", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const damaged = created.value.zip.slice();
    const at = Math.floor(damaged.length * 0.6);
    damaged[at] = damaged[at] === 0 ? 1 : 0;
    const inspected = await service.inspect(toFile(damaged, created.value.fileName), noop);
    expect(inspected.ok).toBe(false);
  });
});
