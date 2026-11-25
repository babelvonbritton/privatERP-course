// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDriveState, writeDriveState, type DriveService } from "@/lib/drive";
import { DriveSyncManager, SYNC_DEBOUNCE_MS } from "@/lib/driveSync";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage, type StorageService } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

const PASSPHRASE = "correct horse battery staple";

/** An in-memory settings store, keyed the way the real Dexie store is. */
function fakeSettings() {
  const map = new Map<string, string | number | boolean | null>();
  return {
    read: async (key: string) => map.get(key),
    write: async (key: string, value: string | number | boolean | null) => {
      map.set(key, value);
    },
    all: async () => [...map.entries()].map(([key, value]) => ({ key, value })),
  };
}

interface Harness {
  manager: DriveSyncManager;
  settings: ReturnType<typeof fakeSettings>;
  drive: {
    refresh: ReturnType<typeof vi.fn>;
    listBackups: ReturnType<typeof vi.fn>;
    uploadBackup: ReturnType<typeof vi.fn>;
  };
  buildArchive: ReturnType<typeof vi.fn>;
  listener: (() => void) | null;
}

async function makeManager(initial: {
  syncEnabled?: boolean;
  passphrase?: string | null;
  accessToken?: string | null;
  tokenExpiresAt?: number | null;
  dirty?: boolean;
} = {}): Promise<Harness> {
  const settings = fakeSettings();
  await writeDriveState(settings as never, {
    syncEnabled: true,
    passphrase: PASSPHRASE,
    accessToken: "tok",
    tokenExpiresAt: Date.now() + 3600_000,
    dirty: false,
    ...initial,
  });
  const drive = {
    refresh: vi.fn(async () => ({ accessToken: "tok-fresh", expiresAt: Date.now() + 3600_000 })),
    listBackups: vi.fn(async () => [] as Array<{ id: string }>),
    uploadBackup: vi.fn(async () => undefined),
  };
  const buildArchive = vi.fn(async () => ({ zip: new Uint8Array([1, 2, 3]) }));
  let listener: (() => void) | null = null;
  const storage = {
    settings,
    onDataChange: (cb: () => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  } as unknown as StorageService;
  const manager = new DriveSyncManager({
    storage,
    drive: drive as unknown as DriveService,
    buildArchive,
  });
  return { manager, settings, drive, buildArchive, listener };
}

describe("DriveSyncManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uploads once after the quiet period when data changes", async () => {
    const h = await makeManager();
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    expect(h.buildArchive).toHaveBeenCalledWith(PASSPHRASE);
    const state = await readDriveState(h.settings as never);
    expect(state.lastSyncedAt).not.toBeNull();
    expect(state.lastBackupAt).toBe(state.lastSyncedAt);
    expect(state.dirty).toBe(false);
    expect(h.manager.getState().status).toBe("idle");
    expect(h.manager.getState().dirty).toBe(false);
    h.manager.stop();
  });

  it("coalesces several rapid writes into a single upload", async () => {
    const h = await makeManager();
    await h.manager.start();
    for (let i = 0; i < 5; i++) {
      h.manager.markDirty();
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("never runs while signed out, even with the toggle on", async () => {
    const h = await makeManager({ accessToken: null, tokenExpiresAt: null });
    h.drive.refresh.mockResolvedValue(null);
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).not.toHaveBeenCalled();
    expect(h.buildArchive).not.toHaveBeenCalled();
    const state = await readDriveState(h.settings as never);
    expect(state.dirty).toBe(true);
    h.manager.stop();
  });

  it("never runs while the toggle is off, even while signed in", async () => {
    const h = await makeManager({ syncEnabled: false });
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).not.toHaveBeenCalled();
    expect(h.buildArchive).not.toHaveBeenCalled();
    h.manager.stop();
  });

  it("never runs without a stored Drive passphrase", async () => {
    const h = await makeManager({ passphrase: null });
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).not.toHaveBeenCalled();
    h.manager.stop();
  });

  it("a failed upload keeps the data dirty and retries on the next change", async () => {
    const h = await makeManager();
    h.drive.uploadBackup.mockRejectedValueOnce(new Error("offline"));
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.manager.getState().status).toBe("error");
    expect(h.manager.getState().lastError).toBe("offline");
    expect((await readDriveState(h.settings as never)).dirty).toBe(true);
    h.drive.uploadBackup.mockResolvedValue(undefined);
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(2);
    expect(h.manager.getState().status).toBe("idle");
    h.manager.stop();
  });

  it("a dirty flag left by a previous session schedules a sync on start", async () => {
    const h = await makeManager({ dirty: true });
    await h.manager.start();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("turning the toggle on with pending changes schedules an upload", async () => {
    const h = await makeManager({ syncEnabled: false });
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).not.toHaveBeenCalled();
    await h.manager.setSyncEnabled(true);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("updates the existing Drive file instead of creating a second one", async () => {
    const h = await makeManager();
    h.drive.listBackups.mockResolvedValue([{ id: "f1" }]);
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledWith("tok", expect.any(Uint8Array), "f1");
    h.manager.stop();
  });

  it("writing the last-synced timestamp schedules no further sync", async () => {
    const h = await makeManager();
    await h.manager.start();
    h.manager.markDirty();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 1000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    // The sync's own bookkeeping wrote lastSyncedAt to the settings store.
    // Advancing far past the debounce must not produce a second upload.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.drive.uploadBackup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    h.manager.stop();
  });
});

describe("DriveSyncManager with the real storage", () => {
  beforeEach(async () => {
    await resetStorage();
    resetServices();
  });

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("a data write syncs, a preference write does not, and the sync never loops on its own bookkeeping", async () => {
    const storage = getStorage();
    await writeDriveState(storage.settings, {
      syncEnabled: true,
      passphrase: PASSPHRASE,
      accessToken: "tok",
      tokenExpiresAt: Date.now() + 3600_000,
    });
    const uploads: Uint8Array[] = [];
    const drive = {
      refresh: vi.fn(async () => null),
      listBackups: vi.fn(async () => [] as Array<{ id: string }>),
      uploadBackup: vi.fn(async (_token: string, bytes: Uint8Array) => {
        uploads.push(bytes);
      }),
    };
    const manager = new DriveSyncManager({
      storage,
      drive: drive as unknown as DriveService,
      buildArchive: async () => ({ zip: new Uint8Array([9, 9]) }),
      debounceMs: 50,
    });
    await manager.start();

    // A preference-only write (tour seen) must not schedule anything.
    await storage.settings.write("pref.tourSeen", true);
    await wait(200);
    expect(uploads).toHaveLength(0);

    // A data write (a new member) syncs once.
    await getServices().members.create({
      name: "Ana",
      email: "ana@example.com",
      phone: "0812000000",
      notes: "",
      status: "active",
      idempotencyKey: createId(),
    });
    await wait(200);
    expect(uploads).toHaveLength(1);
    expect(Array.from(uploads[0])).toEqual([9, 9]);

    // The sync's own bookkeeping (lastSyncedAt) must not trigger another upload.
    await wait(300);
    expect(uploads).toHaveLength(1);
    manager.stop();
  });

  it("a restore marks the data dirty for the next sync", async () => {
    const storage = getStorage();
    await writeDriveState(storage.settings, {
      syncEnabled: true,
      passphrase: PASSPHRASE,
      accessToken: "tok",
      tokenExpiresAt: Date.now() + 3600_000,
    });
    const uploads: Uint8Array[] = [];
    const drive = {
      refresh: vi.fn(async () => null),
      listBackups: vi.fn(async () => [] as Array<{ id: string }>),
      uploadBackup: vi.fn(async (_token: string, bytes: Uint8Array) => {
        uploads.push(bytes);
      }),
    };
    const manager = new DriveSyncManager({
      storage,
      drive: drive as unknown as DriveService,
      buildArchive: async () => ({ zip: new Uint8Array([9, 9]) }),
      debounceMs: 50,
    });
    await manager.start();
    storage.notifyDataChanged();
    await wait(200);
    expect(uploads).toHaveLength(1);
    manager.stop();
  });
});
