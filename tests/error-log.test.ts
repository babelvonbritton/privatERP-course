// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorCenter } from "@/lib/errors/ErrorCenter";
import {
  ERROR_LOG_MAX_ENTRIES,
  buildErrorLogZip,
  enforceErrorLogLimits,
  errorLogFileName,
  installErrorLog,
  persistErrorLog,
  purgeErrorLog,
} from "@/lib/errors/errorLog";
import { getStorage, resetStorage } from "@/lib/storage";
import type { ErrorLogRecord } from "@/lib/domain/types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-27T10:00:00.000Z");

const record = (overrides: Partial<ErrorLogRecord> = {}): Omit<ErrorLogRecord, "id"> => ({
  time: new Date(NOW).toISOString(),
  code: "UNEXPECTED",
  action: "invoice.list",
  message: "UNEXPECTED",
  details: "Something broke",
  ...overrides,
});

const oldRecord = (daysAgo: number): Omit<ErrorLogRecord, "id"> => record({ time: new Date(NOW - daysAgo * DAY).toISOString() });

describe("durable error log", () => {
  beforeEach(async () => {
    await resetStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists what errorCenter captures and lists newest first", async () => {
    const store = getStorage().errorLog;
    await persistErrorLog(record({ code: "STORAGE_FAILED", action: "members.list" }));
    await persistErrorLog(record({ code: "UNEXPECTED", action: "invoice.list", time: new Date(NOW + 1000).toISOString() }));
    expect(await store.count()).toBe(2);
    const recent = await store.listRecent(10);
    expect(recent.map((r) => r.action)).toEqual(["invoice.list", "members.list"]);
    expect(recent[0]).toMatchObject({ code: "UNEXPECTED", message: "UNEXPECTED", details: "Something broke" });
  });

  it("purges entries older than 7 days on write", async () => {
    const store = getStorage().errorLog;
    await store.add(oldRecord(8));
    await store.add(oldRecord(6));
    expect(await store.count()).toBe(2);
    await persistErrorLog(record());
    expect(await store.count()).toBe(2);
    const kept = await store.listAll();
    expect(kept.every((r) => r.time >= new Date(NOW - 7 * DAY).toISOString())).toBe(true);
  });

  it("purges entries older than 7 days on start", async () => {
    const store = getStorage().errorLog;
    await store.add(oldRecord(9));
    await store.add(oldRecord(2));
    await purgeErrorLog(NOW);
    const kept = await store.listAll();
    expect(kept).toHaveLength(1);
    expect(kept[0].time).toBe(new Date(NOW - 2 * DAY).toISOString());
  });

  it("evicts the oldest past the 500-entry cap", async () => {
    const store = getStorage().errorLog;
    for (let i = 0; i < ERROR_LOG_MAX_ENTRIES + 5; i++) {
      await store.add(record({ time: new Date(NOW - i * 1000).toISOString() }));
    }
    await enforceErrorLogLimits(NOW);
    expect(await store.count()).toBe(ERROR_LOG_MAX_ENTRIES);
    const kept = await store.listAll();
    expect(kept[0].time).toBe(new Date(NOW - (ERROR_LOG_MAX_ENTRIES - 1) * 1000).toISOString());
  });

  it("never throws into the reporting path when storage is unavailable", async () => {
    const store = getStorage().errorLog;
    vi.spyOn(store, "add").mockRejectedValueOnce(new Error("no db"));
    await expect(persistErrorLog(record())).resolves.toBeUndefined();
    await expect(enforceErrorLogLimits(NOW)).resolves.toBeUndefined();
    await expect(purgeErrorLog(NOW)).resolves.toBeUndefined();
  });
});

describe("error log export", () => {
  it("names the file by date", () => {
    expect(errorLogFileName(new Date("2026-11-27T10:00:00.000Z"))).toBe("olaseena-errors-2026-11-27.zip");
  });

  it("writes one NDJSON file with the record shape, deflate-compressed", () => {
    const rows: ErrorLogRecord[] = [
      { ...record({ code: "STORAGE_FAILED" }), id: "a" },
      { ...record({ code: "UNEXPECTED", action: "invoice.list" }), id: "b" },
    ];
    const zip = buildErrorLogZip(rows);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const method = zip[8] | (zip[9] << 8);
    expect(method).toBe(8);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(["olaseena-errors.ndjson"]);
    const lines = strFromU8(files["olaseena-errors.ndjson"]).trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toEqual({ time: rows[0].time, code: "STORAGE_FAILED", action: "invoice.list", message: "UNEXPECTED", details: "Something broke" });
    expect(parsed[0]).not.toHaveProperty("id");
    expect(parsed[1].action).toBe("invoice.list");
  });

  it("exports an empty log as an empty NDJSON file", () => {
    const files = unzipSync(buildErrorLogZip([]));
    expect(strFromU8(files["olaseena-errors.ndjson"])).toBe("");
  });
});

describe("uncaught error hooks", () => {
  let stop: () => void;

  beforeEach(async () => {
    await resetStorage();
    stop = installErrorLog();
  });

  afterEach(() => {
    stop();
  });

  it("persists a window error through the normal reporting path", async () => {
    const seen: string[] = [];
    errorCenter.subscribe((event) => {
      if (event.kind === "error") seen.push(event.error.code);
    });
    const error = new Error("boom");
    window.dispatchEvent(new ErrorEvent("error", { error, message: "boom", filename: "https://example.test/app.js", lineno: 12, colno: 3 }));
    await vi.waitFor(async () => {
      expect(await getStorage().errorLog.count()).toBe(1);
    });
    const [entry] = await getStorage().errorLog.listAll();
    expect(entry.action).toBe("window.onerror");
    expect(entry.details).toContain("app.js:12:3");
    expect(entry.details).toContain("boom");
    expect(entry.details).not.toContain(" at ");
    expect(seen).toContain("UNEXPECTED");
  });

  it("does not double-log an error already reported through report()", async () => {
    const error = new Error("already seen");
    errorCenter.report(error, { action: "invoice.list" });
    window.dispatchEvent(new ErrorEvent("error", { error, message: "already seen" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entries = await getStorage().errorLog.listAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("invoice.list");
  });

  it("persists an unhandled rejection", async () => {
    const reason = new Error("rejected");
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    (event as unknown as { reason: unknown }).reason = reason;
    (event as unknown as { promise: Promise<unknown> }).promise = Promise.resolve();
    window.dispatchEvent(event);
    await vi.waitFor(async () => {
      expect(await getStorage().errorLog.count()).toBe(1);
    });
    const [entry] = await getStorage().errorLog.listAll();
    expect(entry.action).toBe("unhandledrejection");
    expect(entry.details).toContain("rejected");
  });
});
