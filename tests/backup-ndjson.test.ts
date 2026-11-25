// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveCodec } from "@/lib/backup/ArchiveCodec";
import { BackupCrypto } from "@/lib/backup/BackupCrypto";
import { BackupService } from "@/lib/backup/BackupService";
import { sha256Hex } from "@/lib/backup/hash";
import { decodeNdjson, encodeNdjson } from "@/lib/backup/Ndjson";
import { BACKUP_STORE_NAMES, MANIFEST_NAME, STORE_TO_FILE } from "@/lib/backup/constants";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import type { BackupManifest } from "@/lib/backup/types";
import type { Attachment } from "@/lib/domain/attachments";

const noop = () => {};
const PASSPHRASE = "correct horse battery staple";

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

async function seed() {
  const s = await freshServices();
  const m = await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
  const m2 = await s.members.create({ name: "Citra", email: "citra@example.com", phone: "0812000002", notes: "", status: "active", idempotencyKey: createId() });
  const t = await s.trainers.create({ name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 150000, status: "active", idempotencyKey: createId() });
  const c = await s.courses.create({ title: "Piano Basics", description: "", level: "Beginner", price: 500000, requiredSkills: ["Piano"], scheduleWeekdays: [1], status: "active", idempotencyKey: createId() });
  return { s, m, m2, t, c };
}

function toFile(zip: Uint8Array, name: string): File {
  return new File([zip as BlobPart], name, { type: "application/zip" });
}

function unzipMap(zip: Uint8Array): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(zip)));
}

function rezip(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files), { level: 6 });
}

function readManifest(files: Map<string, Uint8Array>): BackupManifest {
  return JSON.parse(strFromU8(files.get("manifest.json")!)) as BackupManifest;
}

function writeManifest(files: Map<string, Uint8Array>, manifest: BackupManifest): void {
  files.set("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
}

describe("NDJSON encode and decode", () => {
  it("round-trips records, one JSON object per line", () => {
    const bytes = encodeNdjson([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
    expect(strFromU8(bytes)).toBe('{"id":"a","n":1}\n{"id":"b","n":2}\n');
    const decoded = decodeNdjson(bytes, "database/members.ndjson");
    expect(decoded).toEqual({ records: [{ id: "a", n: 1 }, { id: "b", n: 2 }], badLines: 0 });
  });

  it("encodes an empty store as zero bytes", () => {
    expect(encodeNdjson([]).length).toBe(0);
    expect(decodeNdjson(new Uint8Array(0), "database/members.ndjson")).toEqual({ records: [], badLines: 0 });
  });

  it("counts an invalid line and keeps the rest", () => {
    const bytes = strToU8('{"id":"a"}\nnot json at all\n{"id":"b"}\n');
    const decoded = decodeNdjson(bytes, "database/members.ndjson");
    expect(decoded.records).toEqual([{ id: "a" }, { id: "b" }]);
    expect(decoded.badLines).toBe(1);
  });

  it("rejects a file that is not valid UTF-8", () => {
    expect(() => decodeNdjson(new Uint8Array([0xff, 0xfe, 0xfd]), "database/members.ndjson")).toThrow();
  });
});

describe("backup format 2", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("creates a new-format backup with one NDJSON file per store and no data.json", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.manifest.formatVersion).toBe(2);
    const files = unzipMap(created.value.zip);
    expect([...files.keys()].sort()).toEqual([
      "database/activity_logs.ndjson",
      "database/attachments.ndjson",
      "database/attendance.ndjson",
      "database/courses.ndjson",
      "database/enrollments.ndjson",
      "database/invoices.ndjson",
      "database/members.ndjson",
      "database/payments.ndjson",
      "database/payroll_runs.ndjson",
      "database/sessions.ndjson",
      "database/trainers.ndjson",
      "database/trash.ndjson",
      "database/write_keys.ndjson",
      "manifest.json",
      "settings/configuration.json",
    ]);
    const manifest = readManifest(files);
    expect(manifest.files.map((f) => f.name).sort()).toEqual([...files.keys()].filter((n) => n !== "manifest.json").sort());
    for (const name of BACKUP_STORE_NAMES) {
      expect(manifest.stores[name].count).toBeGreaterThanOrEqual(0);
      expect(manifest.stores[name].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.stores.members.count).toBe(2);
    expect(manifest.stores.attachments.count).toBe(0);
    const settings = JSON.parse(strFromU8(files.get("settings/configuration.json")!)) as { settings: unknown[] };
    expect(Array.isArray(settings.settings)).toBe(true);
    expect(strFromU8(files.get("database/members.ndjson")!).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("restores a new-format backup into an empty database", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, created.value.fileName), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.formatVersion).toBe(2);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name).sort()).toEqual(["Ana", "Citra"]);
    expect((await getServices().courses.list()).map((c) => c.title)).toEqual(["Piano Basics"]);
  });

  it("an encrypted new-format backup needs its passphrase, uses one IV per file, and restores with it", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop, "backup", PASSPHRASE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const manifest = created.value.manifest;
    expect(manifest.encryption).toBeDefined();
    expect(manifest.encryption!.iv).toBeUndefined();
    expect(manifest.encryption!.salt).toMatch(/^[0-9a-f]{32}$/);
    const ivs = manifest.files.map((f) => f.iv);
    expect(ivs.every((iv) => typeof iv === "string" && /^[0-9a-f]{24}$/.test(iv))).toBe(true);
    expect(new Set(ivs).size).toBe(ivs.length);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const file = toFile(created.value.zip, created.value.fileName);
    const wrong = await freshService.inspect(file, noop, "wrong passphrase");
    expect(wrong.ok).toBe(false);
    const right = await freshService.inspect(file, noop, PASSPHRASE);
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    const restored = await freshService.restore(right.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name).sort()).toEqual(["Ana", "Citra"]);
  });

  it("skips a single invalid NDJSON line with a warning and restores the rest of the file", async () => {
    const { m } = await seed();
    void m;
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipMap(created.value.zip);
    const lines = strFromU8(files.get("database/members.ndjson")!).split("\n");
    const citraIndex = lines.findIndex((line) => line.includes("Citra"));
    expect(citraIndex).toBeGreaterThanOrEqual(0);
    lines[citraIndex] = "{broken json";
    const corrupted = strToU8(lines.join("\n"));
    files.set("database/members.ndjson", corrupted);
    const manifest = readManifest(files);
    const entry = manifest.files.find((f) => f.name === STORE_TO_FILE.members)!;
    entry.bytes = corrupted.length;
    entry.sha256 = await sha256Hex(corrupted);
    manifest.stores.members.sha256 = entry.sha256;
    writeManifest(files, manifest);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(rezip(files), "corrupt-line.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.badLines" && w.vars?.count === 1 && w.vars?.store === "members")).toBe(true);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((x) => x.name)).toEqual(["Ana"]);
  });

  it("restores a legacy backup: a single weekday becomes a list, a course time is dropped, and a session without times gets empty times", async () => {
    const { s, c, t } = await seed();
    const session = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Scales", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:30", idempotencyKey: createId() });
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipMap(created.value.zip);
    const courseLines = strFromU8(files.get("database/courses.ndjson")!).split("\n").filter(Boolean);
    const legacyCourses = courseLines.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const { scheduleWeekdays, ...rest } = row;
      return { ...rest, scheduleWeekday: (scheduleWeekdays as number[])[0], scheduleTime: "09:00" };
    });
    const legacyCourseBytes = encodeNdjson(legacyCourses);
    files.set("database/courses.ndjson", legacyCourseBytes);
    const sessionLines = strFromU8(files.get("database/sessions.ndjson")!).split("\n").filter(Boolean);
    const legacySessions = sessionLines.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row.startTime;
      delete row.endTime;
      return row;
    });
    const legacySessionBytes = encodeNdjson(legacySessions);
    files.set("database/sessions.ndjson", legacySessionBytes);
    const manifest = readManifest(files);
    for (const [store, bytes] of [
      ["courses", legacyCourseBytes],
      ["sessions", legacySessionBytes],
    ] as const) {
      const entry = manifest.files.find((f) => f.name === STORE_TO_FILE[store])!;
      entry.bytes = bytes.length;
      entry.sha256 = await sha256Hex(bytes);
      manifest.stores[store].sha256 = entry.sha256;
    }
    writeManifest(files, manifest);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(rezip(files), "legacy.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.unknownFields")).toBe(false);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const restoredCourse = (await getServices().courses.list()).find((x) => x.id === c.id)!;
    expect(restoredCourse.scheduleWeekdays).toEqual([1]);
    expect(restoredCourse).not.toHaveProperty("scheduleTime");
    const restoredSession = (await getServices().attendance.listSessionsByCourse(c.id)).find((x) => x.id === session.id)!;
    expect(restoredSession.startTime).toBe("");
    expect(restoredSession.endTime).toBe("");
  });

  it("restores a pre-v0.9.0 backup: a course carrying a trainerId and a capacity loses both and gains no required skills", async () => {
    const { c } = await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipMap(created.value.zip);
    const courseLines = strFromU8(files.get("database/courses.ndjson")!).split("\n").filter(Boolean);
    const oldCourses = courseLines.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row.requiredSkills;
      return { ...row, trainerId: "t-old", capacity: 10 };
    });
    const oldCourseBytes = encodeNdjson(oldCourses);
    files.set("database/courses.ndjson", oldCourseBytes);
    const manifest = readManifest(files);
    const entry = manifest.files.find((f) => f.name === STORE_TO_FILE.courses)!;
    entry.bytes = oldCourseBytes.length;
    entry.sha256 = await sha256Hex(oldCourseBytes);
    manifest.stores.courses.sha256 = entry.sha256;
    writeManifest(files, manifest);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(rezip(files), "old-course.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.unknownFields")).toBe(false);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const restoredCourse = (await getServices().courses.list()).find((x) => x.id === c.id)!;
    expect(restoredCourse).not.toHaveProperty("trainerId");
    expect(restoredCourse).not.toHaveProperty("capacity");
    expect(restoredCourse.requiredSkills).toEqual([]);
  });

  it("round-trips session capacity through backup and restore: a capped session keeps its cap, an uncapped one stays uncapped", async () => {
    const { s, c, t } = await seed();
    const capped = await s.attendance.createSession({ courseId: c.id, date: "2026-11-09", topic: "Capped", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:00", capacity: 2, idempotencyKey: createId() });
    const uncapped = await s.attendance.createSession({ courseId: c.id, date: "2026-11-16", topic: "Open", trainerId: t.id, trainerPresent: true, startTime: "09:00", endTime: "10:00", idempotencyKey: createId() });
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(created.value.zip, "capacity.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    const sessions = await getServices().attendance.listSessionsByCourse(c.id);
    expect(sessions.find((x) => x.id === capped.id)?.capacity).toBe(2);
    expect(sessions.find((x) => x.id === uncapped.id)?.capacity ?? null).toBeNull();
  });

  it("refuses a backup whose manifest checksum does not match a store file", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipMap(created.value.zip);
    const bytes = files.get("database/members.ndjson")!;
    const tampered = bytes.slice();
    tampered[2] = tampered[2] === 0x58 ? 0x59 : 0x58;
    files.set("database/members.ndjson", tampered);
    const inspected = await service.inspect(toFile(rezip(files), "tampered.zip"), noop);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error.code).toBe("BACKUP_CHECKSUM_MISMATCH");
  });

  it("rejects archives with unexpected entries", async () => {
    await seed();
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const created = await service.createBackup(noop);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const files = unzipMap(created.value.zip);
    files.set("README.txt", strToU8("hello"));
    const extra = await service.inspect(toFile(rezip(files), "extra.zip"), noop);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error.code).toBe("BACKUP_UNEXPECTED_CONTENT");

    const files2 = unzipMap(created.value.zip);
    files2.set("../evil.txt", strToU8("hello"));
    const traversal = await service.inspect(toFile(rezip(files2), "traversal.zip"), noop);
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.code).toBe("BACKUP_UNEXPECTED_CONTENT");

    const files3 = unzipMap(created.value.zip);
    files3.set("database/evil.ndjson", strToU8('{"id":"x"}\n'));
    const unlisted = await service.inspect(toFile(rezip(files3), "unlisted.zip"), noop);
    expect(unlisted.ok).toBe(false);
    if (!unlisted.ok) expect(unlisted.error.code).toBe("BACKUP_UNEXPECTED_CONTENT");
  });

  it("rejects an archive whose entries expand past the total inflated size", { timeout: 30_000 }, () => {
    const files: Record<string, Uint8Array> = { [MANIFEST_NAME]: strToU8("{}") };
    // 150 allowed-name entries of 1 MB each: every entry is under the
    // per-entry cap, but 150 MB inflated in total. The zeros compress to
    // almost nothing, so the ZIP itself stays small, like a real bomb.
    for (let i = 0; i < 150; i++) files[`database/x${i}.ndjson`] = new Uint8Array(1024 * 1024);
    const zip = zipSync(files, { level: 6 });
    let code = "";
    try {
      ArchiveCodec.unpack(zip);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("BACKUP_FILE_TOO_LARGE");
  });

  it("rejects an archive with more entries than the cap", () => {
    const files: Record<string, Uint8Array> = { [MANIFEST_NAME]: strToU8("{}") };
    for (let i = 0; i < 1001; i++) files[`database/x${i}.ndjson`] = new Uint8Array(0);
    const zip = zipSync(files, { level: 6 });
    let code = "";
    try {
      ArchiveCodec.unpack(zip);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("BACKUP_FILE_TOO_LARGE");
  });

  it("keeps restoring when one attachment file in an encrypted backup is damaged", async () => {
    const { s, m } = await seed();
    void s;
    const row: Attachment = { id: "att-1", entityType: "member", entityId: m.id, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 4, width: 10, height: 10, createdAt: Date.now() };
    const data = { ...(await getStorage().snapshots.readAll()), attachments: [row] };
    const { files, manifest } = await ArchiveCodec.describe(data, Date.now(), "backup", [{ name: "assets/images/att-1.jpg", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const key = await BackupCrypto.createKey(PASSPHRASE);
    const packed = await ArchiveCodec.pack(manifest, files, key);
    const zipped = unzipMap(packed.zip);
    const asset = zipped.get("assets/images/att-1.jpg")!;
    const flipped = asset.slice();
    flipped[0] = flipped[0] === 0 ? 1 : 0;
    zipped.set("assets/images/att-1.jpg", flipped);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(rezip(zipped), "damaged-asset.zip"), noop, PASSPHRASE);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.missingAssets" && w.vars?.count === 1)).toBe(true);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect((await getServices().members.list()).map((x) => x.name).sort()).toEqual(["Ana", "Citra"]);
    expect(restored.value.data.attachments).toHaveLength(1);
  });

  it("warns when an attachment file does not match the size in its details", async () => {
    const { s, m } = await seed();
    void s;
    const row: Attachment = { id: "att-1", entityType: "member", entityId: m.id, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 999, width: 10, height: 10, createdAt: Date.now() };
    const data = { ...(await getStorage().snapshots.readAll()), attachments: [row] };
    const { files, manifest } = await ArchiveCodec.describe(data, Date.now(), "backup", [{ name: "assets/images/att-1.jpg", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const packed = await ArchiveCodec.pack(manifest, files);
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await service.inspect(toFile(packed.zip, "size-mismatch.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.assetSizeMismatch" && w.vars?.count === 1)).toBe(true);
  });

  it("carries attachment files through a backup and returns them on inspect", async () => {
    const { s, m } = await seed();
    void s;
    const row: Attachment = { id: "att-1", entityType: "member", entityId: m.id, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 4, width: 10, height: 10, createdAt: Date.now() };
    const data = { ...(await getStorage().snapshots.readAll()), attachments: [row] };
    const { files, manifest } = await ArchiveCodec.describe(data, Date.now(), "backup", [{ name: "assets/images/att-1.jpg", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const packed = await ArchiveCodec.pack(manifest, files);
    const assetEntry = packed.manifest.files.find((f) => f.name === "assets/images/att-1.jpg");
    expect(assetEntry).toBeDefined();
    expect(assetEntry!.bytes).toBe(4);
    expect(assetEntry!.sha256).toBe(await sha256Hex(new Uint8Array([1, 2, 3, 4])));
    expect(packed.manifest.stores.attachments.count).toBe(1);

    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await service.inspect(toFile(packed.zip, "with-asset.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.missingAssets")).toBe(false);
    expect(inspected.value.assets.get("assets/images/att-1.jpg")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(inspected.value.data.attachments).toHaveLength(1);
  });

  it("warns about a missing attachment file, keeps the metadata row, and carries the warning on the restore result", async () => {
    const { s, m } = await seed();
    void s;
    const row: Attachment = { id: "att-1", entityType: "member", entityId: m.id, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 4, width: 10, height: 10, createdAt: Date.now() };
    const data = { ...(await getStorage().snapshots.readAll()), attachments: [row] };
    const { files, manifest } = await ArchiveCodec.describe(data, Date.now(), "backup", [{ name: "assets/images/att-1.jpg", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    const packed = await ArchiveCodec.pack(manifest, files);
    const zipped = unzipMap(packed.zip);
    zipped.delete("assets/images/att-1.jpg");
    const missingZip = rezip(zipped);

    await freshServices();
    const freshService = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const inspected = await freshService.inspect(toFile(missingZip, "missing-asset.zip"), noop);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.warnings.some((w) => w.key === "warn.missingAssets" && w.vars?.count === 1)).toBe(true);
    expect(inspected.value.data.attachments).toHaveLength(1);
    const restored = await freshService.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.warnings.some((w) => w.key === "warn.missingAssets")).toBe(true);
    expect(restored.value.data.attachments.map((a) => a.id)).toEqual(["att-1"]);
  });
});

describe("old-format backup fixtures", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("restores the plain v1 fixture", async () => {
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
    expect((await getServices().trainers.list()).map((t) => t.name)).toEqual(["Budi"]);
    expect((await getServices().courses.list()).map((c) => c.title)).toEqual(["Piano Basics"]);
  });

  it("restores the encrypted v1 fixture with its passphrase", async () => {
    await freshServices();
    const zip = readFileSync("tests/fixtures/olaseena-backup-v1-encrypted.zip");
    const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const file = toFile(zip, "olaseena-backup-v1-encrypted.zip");
    const wrong = await service.inspect(file, noop, "wrong passphrase");
    expect(wrong.ok).toBe(false);
    const inspected = await service.inspect(file, noop, PASSPHRASE);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.manifest.formatVersion).toBe(1);
    const restored = await service.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(restored.ok).toBe(true);
    expect((await getServices().members.list()).map((m) => m.name)).toEqual(["Ana"]);
  });
});
