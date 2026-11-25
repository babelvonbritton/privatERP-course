// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "@/lib/backup/BackupService";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import {
  DEFAULT_DRIVE_CLIENT_ID,
  DRIVE_BACKUP_EXCLUDED_KEYS,
  DRIVE_BACKUP_FILENAME,
  DriveService,
  ensureDriveToken,
  readDriveState,
  resolveDriveClientId,
  stripDriveSecrets,
  writeDriveState,
  type DriveService as DriveServiceType,
} from "@/lib/drive";
import type { BackupData } from "@/lib/domain/types";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

const noop = () => {};
const PASSPHRASE = "correct horse battery staple";

/** Byte-wise equality. Vitest's toEqual fails on same-content Uint8Arrays whose buffers come from another realm (a jsdom Blob), so compare the contents instead. */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

/** A Google Identity Services stub: the token client calls back with `result`, or errors. */
function gisLoader(
  result: { access_token?: string; expires_in: number } | "error",
  prompts: string[] = [],
) {
  return async () => ({
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          callback: (res: { access_token?: string; expires_in: number }) => void;
          error_callback?: (err: unknown) => void;
        }) => ({
          requestAccessToken: (opts: { prompt?: string }) => {
            prompts.push(opts.prompt ?? "");
            if (result === "error") config.error_callback?.(new Error("denied"));
            else config.callback(result);
          },
        }),
      },
    },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const bytesOk = (bytes: Uint8Array) => new Response(bytes as unknown as BodyInit, { status: 200 });
const httpError = (code: number) => new Response("error", { status: code });

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

/** The media part of a multipart upload body, byte for byte. */
async function multipartBytes(body: Blob): Promise<Uint8Array> {
  const boundary = body.type.split("boundary=")[1];
  const buf = new Uint8Array(await body.arrayBuffer());
  const doubleCrlf = [13, 10, 13, 10];
  let start = -1;
  let seen = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (doubleCrlf.every((b, j) => buf[i + j] === b)) {
      seen += 1;
      if (seen === 2) {
        start = i + 4;
        break;
      }
    }
  }
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  let end = -1;
  outer: for (let i = start; i + tail.length <= buf.length; i++) {
    for (let j = 0; j < tail.length; j++) if (buf[i + j] !== tail[j]) continue outer;
    end = i;
    break;
  }
  if (start < 0 || end < 0) throw new Error("multipart parse failed");
  return buf.slice(start, end);
}

describe("DriveService sign-in", () => {
  it("connects with the consent prompt and a token that expires a minute early", async () => {
    const prompts: string[] = [];
    const service = new DriveService(gisLoader({ access_token: "tok-1", expires_in: 3600 }, prompts) as never);
    const before = Date.now();
    const token = await service.connect("client-id");
    expect(prompts).toEqual(["consent"]);
    expect(token.accessToken).toBe("tok-1");
    // One minute of skew margin: expiry sits 3540s out, not 3600s.
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3540_000 - 1000);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 3540_000 + 1000);
  });

  it("refreshes silently, without the consent prompt", async () => {
    const prompts: string[] = [];
    const service = new DriveService(gisLoader({ access_token: "tok-2", expires_in: 3600 }, prompts) as never);
    const token = await service.refresh("client-id");
    expect(prompts).toEqual([""]);
    expect(token?.accessToken).toBe("tok-2");
  });

  it("refresh returns null when the grant is gone instead of throwing", async () => {
    const service = new DriveService(gisLoader("error") as never);
    await expect(service.refresh("client-id")).resolves.toBeNull();
  });

  it("connect fails with DRIVE_GIS_FAILED when sign-in errors or returns no token", async () => {
    const denied = new DriveService(gisLoader("error") as never);
    await expect(denied.connect("client-id")).rejects.toMatchObject({ code: "DRIVE_GIS_FAILED" });
    const empty = new DriveService(gisLoader({ expires_in: 3600 }) as never);
    await expect(empty.connect("client-id")).rejects.toMatchObject({ code: "DRIVE_GIS_FAILED" });
  });

  it("connect fails with DRIVE_GIS_FAILED when the GIS script never loads", async () => {
    const service = new DriveService(async () => {
      throw new Error("script blocked");
    });
    await expect(service.connect("client-id")).rejects.toMatchObject({ code: "DRIVE_GIS_FAILED" });
  });
});

describe("DriveService files", () => {
  it("lists the backup file from the app folder, newest first", async () => {
    const { fetchFn, calls } = mockFetch((url) =>
      jsonOk({ files: [{ id: "f1", name: DRIVE_BACKUP_FILENAME, modifiedTime: "2026-11-25T00:00:00.000Z" }] }),
    );
    const service = new DriveService(undefined, fetchFn);
    const files = await service.listBackups("tok");
    expect(files).toEqual([{ id: "f1", name: DRIVE_BACKUP_FILENAME, modifiedTime: "2026-11-25T00:00:00.000Z" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("spaces=appDataFolder");
    expect(calls[0].url).toContain(encodeURIComponent(DRIVE_BACKUP_FILENAME));
    expect(calls[0].url).toContain("orderBy=modifiedTime desc");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("maps a failed list, upload, and download to their own error codes, and 401 to DRIVE_AUTH", async () => {
    const failing = new DriveService(undefined, mockFetch(() => httpError(500)).fetchFn);
    await expect(failing.listBackups("tok")).rejects.toMatchObject({ code: "DRIVE_LIST_FAILED" });
    await expect(failing.uploadBackup("tok", new Uint8Array([1]), null)).rejects.toMatchObject({ code: "DRIVE_UPLOAD_FAILED" });
    await expect(failing.downloadBackup("tok", "f1")).rejects.toMatchObject({ code: "DRIVE_DOWNLOAD_FAILED" });
    const authed = new DriveService(undefined, mockFetch(() => httpError(401)).fetchFn);
    await expect(authed.listBackups("tok")).rejects.toMatchObject({ code: "DRIVE_AUTH" });
    await expect(authed.uploadBackup("tok", new Uint8Array([1]), null)).rejects.toMatchObject({ code: "DRIVE_AUTH" });
    await expect(authed.downloadBackup("tok", "f1")).rejects.toMatchObject({ code: "DRIVE_AUTH" });
  });

  it("creates the file on first upload and updates the same file afterwards", async () => {
    const { fetchFn, calls } = mockFetch(() => jsonOk({ id: "f1", modifiedTime: "2026-11-25T00:00:00.000Z" }));
    const service = new DriveService(undefined, fetchFn);
    const bytes = new TextEncoder().encode("hello");
    await service.uploadBackup("tok", bytes, null);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    const created = await multipartBytes(calls[0].init.body as Blob);
    expectBytesEqual(created, bytes);
    expect(await (calls[0].init.body as Blob).text()).toContain(DRIVE_BACKUP_FILENAME);
    await service.uploadBackup("tok", bytes, "f1");
    expect(calls[1].init.method).toBe("PATCH");
    expect(calls[1].url).toBe("https://www.googleapis.com/upload/drive/v3/files/f1?uploadType=multipart");
  });

  it("downloads the backup bytes unchanged", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const service = new DriveService(undefined, mockFetch(() => bytesOk(bytes)).fetchFn);
    await expect(service.downloadBackup("tok", "f1")).resolves.toEqual(bytes);
  });
});

describe("resolveDriveClientId", () => {
  it("prefers the user's own Client ID, then the shared default, then null", () => {
    expect(resolveDriveClientId("own-id")).toBe("own-id");
    expect(resolveDriveClientId("  own-id  ")).toBe("own-id");
    expect(resolveDriveClientId(null)).toBe(DEFAULT_DRIVE_CLIENT_ID);
    expect(resolveDriveClientId("   ")).toBe(DEFAULT_DRIVE_CLIENT_ID);
    expect(resolveDriveClientId(null, "  ")).toBeNull();
    expect(resolveDriveClientId(null, "")).toBeNull();
  });
});

describe("ensureDriveToken", () => {
  it("returns the stored token while it is valid without calling refresh", async () => {
    const drive = { refresh: vi.fn() } as unknown as DriveServiceType;
    const token = await ensureDriveToken(
      drive,
      { clientId: null, accessToken: "live", tokenExpiresAt: Date.now() + 3600_000, lastBackupAt: null, syncEnabled: false, lastSyncedAt: null, passphrase: null, dirty: false },
      async () => {},
    );
    expect(token).toBe("live");
    expect(drive.refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, persists the fresh one, and returns it", async () => {
    const fresh = { accessToken: "fresh", expiresAt: Date.now() + 3600_000 };
    const drive = { refresh: vi.fn(async () => fresh) } as unknown as DriveServiceType;
    const persisted: Array<{ accessToken: string; expiresAt: number }> = [];
    const token = await ensureDriveToken(
      drive,
      { clientId: "own-id", accessToken: "stale", tokenExpiresAt: Date.now() - 1000, lastBackupAt: null, syncEnabled: false, lastSyncedAt: null, passphrase: null, dirty: false },
      async (t) => {
        persisted.push(t);
      },
    );
    expect(token).toBe("fresh");
    expect(drive.refresh).toHaveBeenCalledWith("own-id");
    expect(persisted).toEqual([fresh]);
  });

  it("returns null when the refresh fails", async () => {
    const drive = { refresh: vi.fn(async () => null) } as unknown as DriveServiceType;
    const token = await ensureDriveToken(
      drive,
      { clientId: null, accessToken: null, tokenExpiresAt: null, lastBackupAt: null, syncEnabled: false, lastSyncedAt: null, passphrase: null, dirty: false },
      async () => {},
    );
    expect(token).toBeNull();
  });
});

describe("Drive state in the settings store", () => {
  beforeEach(async () => {
    await resetStorage();
  });

  it("round-trips every field and falls back to defaults when nothing is stored", async () => {
    const storage = getStorage();
    const empty = await readDriveState(storage.settings);
    expect(empty).toEqual({
      clientId: null,
      accessToken: null,
      tokenExpiresAt: null,
      lastBackupAt: null,
      syncEnabled: false,
      lastSyncedAt: null,
      passphrase: null,
      dirty: false,
    });
    await writeDriveState(storage.settings, {
      clientId: "own-id",
      accessToken: "tok",
      tokenExpiresAt: 123,
      lastBackupAt: 456,
      syncEnabled: true,
      lastSyncedAt: 789,
      passphrase: "secret",
      dirty: true,
    });
    await expect(readDriveState(storage.settings)).resolves.toEqual({
      clientId: "own-id",
      accessToken: "tok",
      tokenExpiresAt: 123,
      lastBackupAt: 456,
      syncEnabled: true,
      lastSyncedAt: 789,
      passphrase: "secret",
      dirty: true,
    });
    // A partial patch leaves the other fields alone.
    await writeDriveState(storage.settings, { syncEnabled: false });
    const after = await readDriveState(storage.settings);
    expect(after.syncEnabled).toBe(false);
    expect(after.accessToken).toBe("tok");
  });
});

describe("Drive secrets never enter a backup", () => {
  it("stripDriveSecrets removes the six secret keys and keeps the override and the toggle", () => {
    const data: BackupData = {
      members: [],
      trainers: [],
      courses: [],
      enrollments: [],
      sessions: [],
      attendance: [],
      invoices: [],
      payments: [],
      payrollRuns: [],
      auditLog: [],
      writeKeys: [],
      settings: [
        { key: "drive.accessToken", value: "tok" },
        { key: "drive.tokenExpiresAt", value: 1 },
        { key: "drive.passphrase", value: "secret" },
        { key: "drive.lastBackupAt", value: 2 },
        { key: "drive.lastSyncedAt", value: 3 },
        { key: "drive.dirty", value: true },
        { key: "drive.clientId", value: "own-id" },
        { key: "drive.syncEnabled", value: true },
        { key: "pref.currency", value: "IDR" },
      ],
      attachments: [],
      trash: [],
    };
    const stripped = stripDriveSecrets(data);
    expect(stripped.settings.map((s) => s.key)).toEqual(["drive.clientId", "drive.syncEnabled", "pref.currency"]);
    expect(DRIVE_BACKUP_EXCLUDED_KEYS.size).toBe(6);
  });

  it("a backup file carries no Drive secrets, and restoring it keeps the device's Drive state", async () => {
    const s = await freshServices();
    await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const storage = getStorage();
    await writeDriveState(storage.settings, {
      accessToken: "tok-live",
      tokenExpiresAt: 111,
      passphrase: PASSPHRASE,
      lastBackupAt: 222,
      syncEnabled: true,
      clientId: "own-id",
    });
    const service = new BackupService(storage, errorCenter, { minStepMs: 0 });
    const built = await service.buildBackupArchive("backup", PASSPHRASE, noop);
    expect(built.ok).toBe(true);
    if (!built.ok) throw built.error;
    // The settings inside the backup are the decrypted contents: the
    // secrets must be gone, the override and the toggle stay.
    const file = new File([built.value.zip as BlobPart], "olaseena-backup-2026-11-25-0000.zip", { type: "application/zip" });

    // The device's live Drive state changes after the backup was made.
    // (Changed before inspecting, so the restore's staleness check still passes.)
    await writeDriveState(storage.settings, { accessToken: "tok-new", passphrase: "other-passphrase", lastBackupAt: 999 });
    const inspected = await service.inspect(file, noop, PASSPHRASE);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw inspected.error;
    const keys = inspected.value.data.settings.map((r) => r.key);
    for (const secret of DRIVE_BACKUP_EXCLUDED_KEYS) expect(keys).not.toContain(secret);
    expect(keys).toContain("drive.clientId");
    expect(keys).toContain("drive.syncEnabled");

    const out = await service.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(out.ok).toBe(true);
    const after = await readDriveState(storage.settings);
    expect(after.accessToken).toBe("tok-new");
    expect(after.passphrase).toBe("other-passphrase");
    expect(after.lastBackupAt).toBe(999);
    expect(after.clientId).toBe("own-id");
    expect(after.syncEnabled).toBe(true);
  });

  it("round-trips a backup through the mocked Drive client and restores the same data", async () => {
    const s = await freshServices();
    await s.members.create({ name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", idempotencyKey: createId() });
    const storage = getStorage();
    const service = new BackupService(storage, errorCenter, { minStepMs: 0 });
    const built = await service.buildBackupArchive("backup", PASSPHRASE, noop);
    expect(built.ok).toBe(true);
    if (!built.ok) throw built.error;

    let stored: Uint8Array | null = null;
    const { fetchFn } = mockFetch(async (url, init) => {
      if (url.includes("/upload/drive/v3/files")) {
        stored = await multipartBytes(init.body as Blob);
        return jsonOk({ id: "f1", modifiedTime: "2026-11-25T00:00:00.000Z" });
      }
      if (url.includes("alt=media") && stored) return bytesOk(stored);
      return jsonOk({ files: stored ? [{ id: "f1", name: DRIVE_BACKUP_FILENAME, modifiedTime: "2026-11-25T00:00:00.000Z" }] : [] });
    });
    const drive = new DriveService(undefined, fetchFn);
    expect(await drive.listBackups("tok")).toEqual([]);
    await drive.uploadBackup("tok", built.value.zip, null);
    expect(stored).not.toBeNull();
    expectBytesEqual(stored!, built.value.zip);
    const found = await drive.listBackups("tok");
    expect(found.map((f) => f.id)).toEqual(["f1"]);
    const downloaded = await drive.downloadBackup("tok", "f1");
    expectBytesEqual(downloaded, built.value.zip);

    // Restore the downloaded bytes into an empty database: the same member comes back.
    await resetStorage();
    resetServices();
    const fresh = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
    const file = new File([downloaded as BlobPart], DRIVE_BACKUP_FILENAME, { type: "application/zip" });
    const inspected = await fresh.inspect(file, noop, PASSPHRASE);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw inspected.error;
    const out = await fresh.restore(inspected.value, { safetyBackup: false, decisions: new Map(), onRestored: async () => {} }, noop);
    expect(out.ok).toBe(true);
    const members = await getServices().members.list();
    expect(members.map((m) => m.name)).toEqual(["Ana"]);
  });
});
