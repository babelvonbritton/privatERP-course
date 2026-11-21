/** Backup format limits and names. Bump BACKUP_FORMAT_VERSION when the file layout changes. */
export const BACKUP_FORMAT = "olaseena-backup";
export const BACKUP_FORMAT_VERSION = 2;
/** Must equal the IndexedDB schema version in OlaseenaDatabase. */
export const DB_SCHEMA_VERSION = 3;

export const MANIFEST_NAME = "manifest.json";
/** Version 1 only: the single JSON payload. Version 2 stores one NDJSON file per store instead. */
export const DATA_NAME = "data.json";
export const CONFIGURATION_NAME = "settings/configuration.json";

/**
 * Largest backup ZIP accepted, in bytes. Raised from 25 MB to 100 MB for
 * format 2 because attachment files travel inside the archive now; a single
 * attachment is capped separately (see MAX_ATTACHMENT_BYTES) and each ZIP
 * entry is still bounded by MAX_ENTRY_BYTES.
 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/**
 * Largest total inflated size accepted when opening a ZIP, in bytes. The
 * per-entry cap alone cannot bound the total: a ZIP may hold any number of
 * allowed entries, so without this a small archive could expand to
 * gigabytes and kill the tab. Plaintext backup content for this app is far
 * below this ceiling.
 */
export const MAX_TOTAL_INFLATED_BYTES = 100 * 1024 * 1024;
/** Largest number of entries accepted in one backup ZIP. A real backup holds about fifteen. */
export const MAX_ENTRIES = 1000;
export const MAX_RECORDS_PER_STORE = 200_000;

export const STORE_NAMES = [
  "members",
  "trainers",
  "courses",
  "enrollments",
  "sessions",
  "attendance",
  "invoices",
  "payments",
  "payrollRuns",
  "auditLog",
  "writeKeys",
  "settings",
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** Every store the backup format knows, including attachments, which has no IndexedDB store yet. */
export const BACKUP_STORE_NAMES = [...STORE_NAMES, "attachments", "trash"] as const;
export type BackupStoreName = (typeof BACKUP_STORE_NAMES)[number];

/** Where each store lives inside a format 2 archive. Settings use JSON, every other store uses NDJSON. */
export const STORE_TO_FILE: Record<BackupStoreName, string> = {
  members: "database/members.ndjson",
  trainers: "database/trainers.ndjson",
  courses: "database/courses.ndjson",
  enrollments: "database/enrollments.ndjson",
  sessions: "database/sessions.ndjson",
  attendance: "database/attendance.ndjson",
  invoices: "database/invoices.ndjson",
  payments: "database/payments.ndjson",
  payrollRuns: "database/payroll_runs.ndjson",
  auditLog: "database/activity_logs.ndjson",
  writeKeys: "database/write_keys.ndjson",
  settings: "settings/configuration.json",
  attachments: "database/attachments.ndjson",
  trash: "database/trash.ndjson",
};
