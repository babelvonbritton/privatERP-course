// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { OlaseenaDatabase } from "@/lib/storage/OlaseenaDatabase";

const DB_NAME = "olaseena-migration-test";

/** Creates a database shaped like version 3, with the version 3 stores. */
function createV3Database(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("members", { keyPath: "id" });
      db.createObjectStore("trainers", { keyPath: "id" });
      db.createObjectStore("courses", { keyPath: "id" });
      db.createObjectStore("enrollments", { keyPath: "id" });
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("attendance", { keyPath: "id" });
      db.createObjectStore("invoices", { keyPath: "id" });
      db.createObjectStore("payments", { keyPath: "id" });
      db.createObjectStore("payrollRuns", { keyPath: "id" });
      db.createObjectStore("auditLog", { keyPath: "id" });
      db.createObjectStore("writeKeys", { keyPath: "key" });
      db.createObjectStore("settings", { keyPath: "key" });
      db.createObjectStore("attachments", { keyPath: "id" });
      db.createObjectStore("attachmentBlobs", { keyPath: "id" });
      db.createObjectStore("trash", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRow(db: IDBDatabase, store: string, row: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("version 4 migration", () => {
  it("converts a legacy course and a timeless session on open", async () => {
    const raw = await createV3Database(DB_NAME);
    const now = Date.now();
    await putRow(raw, "courses", {
      id: "c1",
      title: "Piano",
      description: "",
      level: "Beginner",
      price: 100000,
      capacity: 5,
      trainerId: "t1",
      scheduleWeekday: 1,
      scheduleTime: "09:00",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await putRow(raw, "sessions", {
      id: "s1",
      courseId: "c1",
      date: "2026-11-10",
      topic: "Scales",
      trainerId: "t1",
      trainerPresent: true,
      createdAt: now,
      updatedAt: now,
    });
    raw.close();

    const db = new OlaseenaDatabase(DB_NAME);
    try {
      await db.open();
      const course = await db.courses.get("c1");
      expect(course?.scheduleWeekdays).toEqual([1]);
      expect(course).not.toHaveProperty("scheduleWeekday");
      const session = await db.sessions.get("s1");
      expect(session?.startTime).toBe("");
      expect(session?.endTime).toBe("");
    } finally {
      db.close();
    }
    await deleteDatabase(DB_NAME);
  });
});
