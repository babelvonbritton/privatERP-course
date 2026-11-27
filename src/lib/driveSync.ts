import { AppError } from "@/lib/errors/AppError";
import { BackupService } from "@/lib/backup/BackupService";
import { ensureDriveToken, readDriveState, writeDriveState, DriveService } from "@/lib/drive";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import { getStorage, type StorageService } from "@/lib/storage";

export const SYNC_DEBOUNCE_MS = 8000;

type SyncStatus = "idle" | "syncing" | "error";

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
  dirty: boolean;
}

interface DriveSyncDeps {
  storage: StorageService;
  drive: DriveService;
  buildArchive: (passphrase: string) => Promise<{ zip: Uint8Array }>;
  debounceMs?: number;
  now?: () => number;
}

export class DriveSyncManager {
  private readonly listeners = new Set<(state: SyncState) => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private syncAgain = false;
  private dirty = false;
  private persistedDirty = false;
  private state: SyncState = { status: "idle", lastSyncedAt: null, lastError: null, dirty: false };
  private readonly now: () => number;

  constructor(private readonly deps: DriveSyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): SyncState {
    return { ...this.state };
  }

  /** Starts listening for data changes. A dirty flag left by a previous session schedules a sync, so a change made just before the app closed is not lost. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.storage.onDataChange(() => this.markDirty());
    const state = await readDriveState(this.deps.storage.settings);
    this.dirty = state.dirty;
    this.persistedDirty = state.dirty;
    this.setState({ lastSyncedAt: state.lastSyncedAt, dirty: state.dirty });
    if (state.dirty) this.scheduleSync();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Marks the data dirty and schedules one upload after the quiet period. Called on every data write; rapid calls coalesce into a single upload. */
  markDirty(): void {
    this.dirty = true;
    this.setState({ dirty: true });
    this.persistDirty();
    this.scheduleSync();
  }

  /**
   * Persists the dirty flag so a missed upload is retried after a restart.
   * Deferred to the next macrotask: a data write often happens inside a
   * Dexie transaction, and a settings write from inside that transaction's
   * scope would fail. A macrotask runs outside the transaction.
   */
  private persistDirty(): void {
    if (this.persistedDirty) return;
    this.persistedDirty = true;
    setTimeout(() => {
      void writeDriveState(this.deps.storage.settings, { dirty: true }).catch(() => {
        this.persistedDirty = false;
      });
    }, 0);
  }

  private scheduleSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.deps.debounceMs ?? SYNC_DEBOUNCE_MS);
  }

  /** Turns auto-sync on or off. Turning it on with pending changes schedules an upload. */
  async setSyncEnabled(on: boolean): Promise<void> {
    await writeDriveState(this.deps.storage.settings, { syncEnabled: on });
    if (on && this.dirty) this.scheduleSync();
  }

  /**
   * Runs one sync when the gating holds: signed in, auto-sync on, and a
   * stored Drive passphrase. Never throws: a failed run keeps the data dirty
   * for the next change, and the error is kept for the Drive section to show.
   */
  async syncNow(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      const state = await readDriveState(this.deps.storage.settings);
      if (!state.syncEnabled || !state.passphrase) return;
      const token = await ensureDriveToken(this.deps.drive, state, async (t) => {
        await writeDriveState(this.deps.storage.settings, { accessToken: t.accessToken, tokenExpiresAt: t.expiresAt });
      });
      if (!token) return;
      this.setState({ status: "syncing", lastError: null });
      const { zip } = await this.deps.buildArchive(state.passphrase);
      const existing = await this.deps.drive.listBackups(token);
      await this.deps.drive.uploadBackup(token, zip, existing[0]?.id ?? null);
      const at = this.now();
      await writeDriveState(this.deps.storage.settings, { lastBackupAt: at, lastSyncedAt: at, dirty: false });
      this.dirty = false;
      this.persistedDirty = false;
      this.setState({ status: "idle", lastSyncedAt: at, dirty: false });
    } catch (e) {
      const message = e instanceof AppError ? e.code : e instanceof Error ? e.message : String(e);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.syncing = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        if (this.dirty) this.scheduleSync();
      }
    }
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.getState());
  }
}

let shared: DriveSyncManager | null = null;

/** The app-wide sync manager, built once with the real services. */
export function getDriveSyncManager(): DriveSyncManager {
  if (!shared) {
    shared = new DriveSyncManager({
      storage: getStorage(),
      drive: new DriveService(),
      buildArchive: async (passphrase) => {
        const service = new BackupService(getStorage(), errorCenter, { minStepMs: 0 });
        const out = await service.buildBackupArchive("backup", passphrase, () => {});
        if (!out.ok) throw out.error;
        return { zip: out.value.zip };
      },
    });
  }
  return shared;
}

/** Forgets the shared manager, so the next call builds one against the current storage. Used by tests to start each one from a clean state (the manager captures the storage it was built with, and resetStorage swaps it). */
export function resetDriveSyncManager(): void {
  shared?.stop();
  shared = null;
}

/** Starts the app-wide auto-sync. Returns a stop function. Safe to call repeatedly. */
export function startDriveSync(): () => void {
  const manager = getDriveSyncManager();
  void manager.start();
  return () => manager.stop();
}
