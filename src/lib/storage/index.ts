import { IntegrityChecker, type IntegrityReport } from "./IntegrityChecker";
import { OlaseenaDatabase } from "./OlaseenaDatabase";
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

export interface StorageReport {
  /** Preference keys whose stored value was not allowed and was reset to the default. */
  repairedPreferences: string[];
  counts: { members: number; trainers: number; courses: number; enrollments: number; sessions: number; attendance: number; invoices: number; payments: number; payrollRuns: number; trash: number };
  integrity: IntegrityReport;
}

/** Single entry point that wires the database, repositories and services together. */
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
  readonly snapshots: SnapshotService;
  readonly integrity: IntegrityChecker;
  private initPromise: Promise<StorageReport> | null = null;

  constructor(readonly db: OlaseenaDatabase = new OlaseenaDatabase(), clock: Clock = Date.now) {
    this.members = new DexieMemberStore(db.members, clock);
    this.trainers = new DexieTrainerStore(db.trainers, clock);
    this.courses = new DexieCourseStore(db.courses, clock);
    this.enrollments = new DexieEnrollmentStore(db.enrollments, clock);
    this.sessions = new DexieSessionStore(db.sessions, clock);
    this.attendance = new DexieAttendanceStore(db.attendance, clock);
    this.invoices = new DexieInvoiceStore(db.invoices, clock);
    this.payments = new DexiePaymentStore(db.payments, clock);
    this.payrollRuns = new DexiePayrollStore(db.payrollRuns, clock);
    this.audit = new DexieAuditStore(db.auditLog, clock);
    this.writeKeys = new DexieWriteKeyStore(db.writeKeys, clock);
    this.settings = new DexieSettingsStore(db.settings, clock);
    this.trash = new DexieTrashStore(db.trash, clock);
    this.preferences = new PreferenceService(this.settings);
    this.snapshots = new SnapshotService(db);
    this.integrity = new IntegrityChecker(db, clock);
  }

  /** Schema version of the open database. */
  get schemaVersion(): number {
    return this.db.verno;
  }

  /** Re-reads preferences, for example after a restore changed the settings store. */
  reloadPreferences(): Promise<Preferences> {
    return this.preferences.load().then((r) => r.preferences);
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
export type { IntegrityReport, IntegrityIssue } from "./IntegrityChecker";
