import { zipSync } from "fflate";
import { encodeNdjson } from "@/lib/backup/Ndjson";
import { FileSaver } from "@/lib/backup/FileSaver";
import { getStorage } from "@/lib/storage";
import type { ErrorLogRecord } from "@/lib/domain/types";
import { AppError } from "./AppError";
import { errorCenter } from "./ErrorCenter";

export const ERROR_LOG_RETENTION_DAYS = 7;
export const ERROR_LOG_MAX_ENTRIES = 500;
export const ERROR_LOG_FILE_NAME = "olaseena-errors.ndjson";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 2000;

type NewRecord = Omit<ErrorLogRecord, "id">;

/** File name for an error-log export: olaseena-errors-YYYY-MM-DD.zip. */
export function errorLogFileName(now: Date = new Date()): string {
  return `olaseena-errors-${now.toISOString().slice(0, 10)}.zip`;
}

/** One NDJSON file of error records, compressed at deflate level 9. The stored id is dropped: the export holds the record shape errorCenter captures. */
export function buildErrorLogZip(records: readonly ErrorLogRecord[]): Uint8Array {
  const ndjson = encodeNdjson(records.map((r) => ({ time: r.time, code: r.code, action: r.action, message: r.message, details: r.details })));
  return zipSync({ [ERROR_LOG_FILE_NAME]: [ndjson, { level: 9, mtime: new Date() }] }, { level: 9 });
}

/** Writes one record to the durable log and enforces retention and the entry cap. Never throws. */
export async function persistErrorLog(record: NewRecord): Promise<void> {
  try {
    await getStorage().errorLog.add(record);
    await enforceErrorLogLimits();
  } catch {
    // A logging failure must never surface as another error.
  }
}

/** Deletes entries older than 7 days, then evicts the oldest past the 500-entry cap. Never throws. */
export async function enforceErrorLogLimits(now: number = Date.now()): Promise<void> {
  try {
    const store = getStorage().errorLog;
    const cutoff = new Date(now - ERROR_LOG_RETENTION_DAYS * DAY_MS).toISOString();
    await store.deleteOlderThan(cutoff);
    const count = await store.count();
    if (count > ERROR_LOG_MAX_ENTRIES) await store.deleteOldest(count - ERROR_LOG_MAX_ENTRIES);
  } catch {
    // A logging failure must never surface as another error.
  }
}

/** Deletes entries older than 7 days. Used at app start. Never throws. */
export async function purgeErrorLog(now: number = Date.now()): Promise<void> {
  try {
    const cutoff = new Date(now - ERROR_LOG_RETENTION_DAYS * DAY_MS).toISOString();
    await getStorage().errorLog.deleteOlderThan(cutoff);
  } catch {
    // A logging failure must never surface as another error.
  }
}

/** Exports the whole durable log as NDJSON in a level-9 ZIP and downloads it. Notifies on success; throws on failure. */
export async function exportErrorLog(now: Date = new Date()): Promise<void> {
  const records = await getStorage().errorLog.listAll();
  const zip = buildErrorLogZip(records);
  FileSaver.download(zip, errorLogFileName(now));
  errorCenter.notify({ key: "toast.errorLogExported" });
}

let installed = false;
const recentUncaught = new Set<string>();

/** Routes an uncaught error through the normal reporting path, unless this exact error was already reported or the same uncaught error just fired. */
function reportUncaught(error: unknown, action: "window.onerror" | "unhandledrejection", location: string): void {
  if (errorCenter.wasReported(error)) return;
  const message = error instanceof Error ? error.message : String(error);
  const key = `${action}:${message}`;
  if (recentUncaught.has(key)) return;
  recentUncaught.add(key);
  setTimeout(() => recentUncaught.delete(key), DEDUPE_WINDOW_MS);
  if (error instanceof AppError) {
    errorCenter.report(error, { action });
    return;
  }
  const name = error instanceof Error && error.name ? `${error.name}: ` : "";
  const details = [location, `${name}${message}`.trim()].filter((part) => part.length > 0).join(" ");
  errorCenter.report(new AppError("UNEXPECTED", { details, cause: error instanceof Error ? error : undefined }), { action });
}

function onWindowError(event: ErrorEvent): void {
  const location = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
  reportUncaught(event.error ?? event.message, "window.onerror", location);
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  reportUncaught(event.reason, "unhandledrejection", "");
}

/** Installs the durable error log once: report() writes through to IndexedDB, and uncaught errors surface through the same path. Returns a cleanup that removes the window handlers. */
export function installErrorLog(): () => void {
  if (installed) return () => {};
  installed = true;
  errorCenter.setSink((record) => {
    void persistErrorLog(record);
  });
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    installed = false;
    window.removeEventListener("error", onWindowError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
