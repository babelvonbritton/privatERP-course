export const BACKUP_FORMAT = "olaseena-backup";
export const BACKUP_FORMAT_VERSION = 2;
export const DB_SCHEMA_VERSION = 3;

export const MANIFEST_NAME = "manifest.json";
export const DATA_NAME = "data.json";
export const CONFIGURATION_NAME = "settings/configuration.json";

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_INFLATED_BYTES = 100 * 1024 * 1024;
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

export const BACKUP_STORE_NAMES = [...STORE_NAMES, "attachments", "trash"] as const;
export type BackupStoreName = (typeof BACKUP_STORE_NAMES)[number];

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
