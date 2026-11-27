import { APP_NAME, APP_VERSION } from "@/lib/appInfo";
import type { ErrorLogRecord } from "@/lib/domain/types";
import type { Msg } from "@/i18n/types";
import { AppError } from "./AppError";

export type ToastEvent =
  | { id: number; kind: "error"; error: AppError }
  | { id: number; kind: "success"; msg: Msg };

type LogRecord = Omit<ErrorLogRecord, "id">;

interface ReportOptions {
  action?: string;
  surface?: "toast" | "inline";
}

export class ErrorCenter {
  private readonly log: LogRecord[] = [];
  private readonly listeners = new Set<(event: ToastEvent) => void>();
  private readonly reported = new WeakSet<object>();
  private sink: ((record: LogRecord) => void) | null = null;
  private lastToast = { key: "", at: 0 };
  private seq = 0;

  /** Registers the durable-log sink. A sink that throws never breaks reporting: the failure is swallowed here. */
  setSink(sink: (record: LogRecord) => void): void {
    this.sink = sink;
  }

  /** True when this exact error object already went through report(). */
  wasReported(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.reported.has(error);
  }

  report(error: unknown, options: ReportOptions = {}): AppError {
    const appError = AppError.from(error);
    const action = options.action ?? "app";
    const record: LogRecord = { time: new Date().toISOString(), code: appError.code, action, message: appError.message, details: appError.details ?? "" };
    this.log.push(record);
    if (this.log.length > 50) this.log.shift();
    if (typeof error === "object" && error !== null) this.reported.add(error);
    if (this.sink) {
      try {
        this.sink(record);
      } catch {
        // Persistence must never break reporting.
      }
    }
    console.error(`[Olaseena] ${appError.code} during ${action}`, appError.details ?? "", appError.cause ?? "");

    if (options.surface !== "inline") {
      const key = `${appError.code}:${action}`;
      const now = Date.now();
      if (key !== this.lastToast.key || now - this.lastToast.at > 2000) {
        this.lastToast = { key, at: now };
        this.emit({ id: ++this.seq, kind: "error", error: appError });
      }
    }
    return appError;
  }

  /** Shows a short success notification. */
  notify(msg: Msg): void {
    this.emit({ id: ++this.seq, kind: "success", msg });
  }

  subscribe(listener: (event: ToastEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plain-text report for support. Contains error codes and record paths only, never item or note text. */
  diagnostics(current?: AppError): string {
    const lines = [`${APP_NAME} diagnostics`, `Version: ${APP_VERSION}`, `Time: ${new Date().toISOString()}`, `Browser: ${typeof navigator === "undefined" ? "n/a" : navigator.userAgent}`];
    if (current) lines.push("", `Error: ${current.code}`, current.details ? `Details:\n${current.details}` : "Details: none");
    lines.push("", "Recent errors (newest first):");
    for (const r of [...this.log].reverse().slice(0, 15)) lines.push(`- ${r.time} ${r.code} [${r.action}] ${r.details.split("\n")[0].slice(0, 160)}`);
    return lines.join("\n");
  }

  private emit(event: ToastEvent): void {
    this.listeners.forEach((l) => l(event));
  }
}

export const errorCenter = new ErrorCenter();
