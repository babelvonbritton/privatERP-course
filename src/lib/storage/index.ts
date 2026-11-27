import { IntegrityChecker, type IntegrityReport } from "./IntegrityChecker";
import { OlaseenaDatabase } from "./OlaseenaDatabase";
import { BusinessProfileService, type BusinessProfile } from "./BusinessProfileService";
import { PreferenceService, type Preferences } from "./PreferenceService";
import {
  DexieAttendanceStore,
  DexieAuditStore,
  DexieCourseStore,
  DexieEnrollmentStore,
  DexieInvoiceStore,
  DexieMemberStore,
  DexiePaymentStore,
  DexiePayrollStore,
  DexieSessionStore,
  DexieSettingsStore,
  DexieTrainerStore,
  DexieTrashStore,
  DexieWriteKeyStore,
} from "./repositories";
import { SnapshotService } from "./SnapshotService";
import type { Clock } from "./types";

interface StorageReport {
  repairedPreferences: string[];
  counts: { members: number; trainers: number; courses: number; enrollments: number; sessions: number; attendance: number; invoices: number; payments: number; payrollRuns: number; trash: number };
  integrity: IntegrityReport;
}

export class StorageService {
  readonly members: DexieMemberStore;
  readonly trainers: DexieTrainerStore;
  readonly courses: DexieCourseStore;
  readonly enrollments: DexieEnrollmentStore;
  readonly sessions: DexieSessionStore;
  readonly attendance: DexieAttendanceStore;
  readonly invoices: DexieInvoiceStore;
  readonly payments: DexiePaymentStore;
  readonly payrollRuns: DexiePayrollStore;
  readonly audit: DexieAuditStore;
  readonly writeKeys: DexieWriteKeyStore;
  readonly settings: DexieSettingsStore;
  readonly trash: DexieTrashStore;
  readonly preferences: PreferenceService;
  readonly profile: BusinessProfileService;
  readonly snapshots: SnapshotService;
  readonly integrity: IntegrityChecker;
  private initPromise: Promise<StorageReport> | null = null;
  private readonly dataChangeListeners = new Set<() => void>();
  /** Passed to every data store; runs after a write lands. Listeners only set in-memory state and schedule timers. They do no database work here, so a write inside a Dexie transaction is safe. */
  private readonly notifyWrite = () => this.notifyDataChanged();

  constructor(readonly db: OlaseenaDatabase = new OlaseenaDatabase(), clock: Clock = Date.now) {
    this.members = new DexieMemberStore(db.members, clock, this.notifyWrite);
    this.trainers = new DexieTrainerStore(db.trainers, clock, this.notifyWrite);
    this.courses = new DexieCourseStore(db.courses, clock, this.notifyWrite);
    this.enrollments = new DexieEnrollmentStore(db.enrollments, clock, this.notifyWrite);
    this.sessions = new DexieSessionStore(db.sessions, clock, this.notifyWrite);
    this.attendance = new DexieAttendanceStore(db.attendance, clock, this.notifyWrite);
    this.invoices = new DexieInvoiceStore(db.invoices, clock, this.notifyWrite);
    this.payments = new DexiePaymentStore(db.payments, clock, this.notifyWrite);
    this.payrollRuns = new DexiePayrollStore(db.payrollRuns, clock, this.notifyWrite);
    this.audit = new DexieAuditStore(db.auditLog, clock, this.notifyWrite);
    this.writeKeys = new DexieWriteKeyStore(db.writeKeys, clock, this.notifyWrite);
    this.settings = new DexieSettingsStore(db.settings, clock);
    this.trash = new DexieTrashStore(db.trash, clock, this.notifyWrite);
    this.preferences = new PreferenceService(this.settings);
    this.profile = new BusinessProfileService(this.settings);
    this.snapshots = new SnapshotService(db);
    this.integrity = new IntegrityChecker(db, clock);
  }

  /** Subscribes to data-store writes. Returns an unsubscribe function. */
  onDataChange(listener: () => void): () => void {
    this.dataChangeListeners.add(listener);
    return () => {
      this.dataChangeListeners.delete(listener);
    };
  }

  /** Tells every data-change listener that a data store was written. Used by the stores and by flows that write past them (a restore replaces whole tables at once). */
  notifyDataChanged(): void {
    for (const listener of this.dataChangeListeners) listener();
  }

  /** Schema version of the open database. */
  get schemaVersion(): number {
    return this.db.verno;
  }

  /** Re-reads preferences, for example after a restore changed the settings store. */
  reloadPreferences(): Promise<Preferences> {
    return this.preferences.load().then((r) => r.preferences);
  }

  /** Re-reads the business profile, for example after a restore changed the settings store. */
  reloadProfile(): Promise<BusinessProfile> {
    return this.profile.load().then((r) => r.profile);
  }

  /** Opens the database, loads preferences and verifies integrity. Safe to call repeatedly. */
  init(): Promise<StorageReport> {
    this.initPromise ??= this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<StorageReport> {
    await this.db.open();
    const { repaired } = await this.preferences.load();
    const [members, trainers, courses, enrollments, sessions, attendance, invoices, payments, payrollRuns, trash, integrity] = await Promise.all([
      this.members.count(),
      this.trainers.count(),
      this.courses.count(),
      this.enrollments.count(),
      this.sessions.count(),
      this.attendance.count(),
      this.invoices.count(),
      this.payments.count(),
      this.payrollRuns.count(),
      this.trash.count(),
      this.integrity.run(),
    ]);
    return { repairedPreferences: repaired, counts: { members, trainers, courses, enrollments, sessions, attendance, invoices, payments, payrollRuns, trash }, integrity };
  }
}

let shared: StorageService | null = null;

/** Deletes the shared database and forgets the service. Used by tests to start each one from a clean state. */
export async function resetStorage(): Promise<void> {
  if (!shared) return;
  await shared.db.delete();
  shared = null;
}

/** Lazily creates the shared service in the browser (never during server prerender). */
export function getStorage(): StorageService {
  shared ??= new StorageService();
  return shared;
}

export * from "@/lib/domain/types";
export * from "./Guard";
export * from "./utils";
export { LocalPrefs } from "./LocalPrefs";
export type { Preferences } from "./PreferenceService";
export type { BusinessProfile } from "./BusinessProfileService";
export type { IntegrityReport, IntegrityIssue } from "./IntegrityChecker";
