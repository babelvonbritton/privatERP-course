// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const trainer = (name: string, subjects: string[]) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000001",
  subjects,
  ratePerSession: 100000,
  status: "active" as const,
  idempotencyKey: createId(),
});

async function seed() {
  const s = await freshServices();
  const piano = await s.trainers.create(trainer("Budi", ["Piano", "Guitar"]));
  const drums = await s.trainers.create(trainer("Dewi", ["Drums"]));
  const course = await s.courses.create({
    title: "Piano",
    description: "",
    level: "Beginner",
    price: 100000,
    capacity: 5,
    requiredSkills: ["Piano", "Violin"],
    scheduleWeekdays: [1],
    status: "active",
    idempotencyKey: createId(),
  });
  return { s, piano, drums, course };
}

/** 2026-11-09 is a Monday, on the course's slot; 2026-11-10 is a Tuesday, off it. */
const sessionOn = (courseId: string, trainerId: string, date = "2026-11-09", topic = "Scales") => ({
  courseId,
  date,
  topic,
  trainerId,
  trainerPresent: false,
  startTime: "09:00",
  endTime: "10:00",
  idempotencyKey: createId(),
});

describe("session trainer rules", () => {
  it("a session requires a trainer: empty or missing trainer is rejected", async () => {
    const { s, course } = await seed();
    await expect(s.attendance.createSession(sessionOn(course.id, ""))).rejects.toThrow();
    await expect(s.attendance.createSession(sessionOn(course.id, "no-such-trainer"))).rejects.toThrow("trainer does not exist");
  });

  it("a trainer with none of the course's required skills is rejected with the unqualified kind", async () => {
    const { s, drums, course } = await seed();
    try {
      await s.attendance.createSession(sessionOn(course.id, drums.id));
      expect.unreachable("an unqualified trainer must be rejected");
    } catch (e) {
      const err = e as { kind?: string; vars?: Record<string, string | number> };
      expect(err?.kind).toBe("unqualifiedTrainer");
      expect(err?.vars?.skills).toBe("Piano, Violin");
    }
  });

  it("a trainer with at least one required skill can teach the session", async () => {
    const { s, piano, course } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, piano.id));
    expect(session.trainerId).toBe(piano.id);
  });

  it("the weekly slot is still enforced for a qualified trainer", async () => {
    const { s, piano, course } = await seed();
    await expect(s.attendance.createSession(sessionOn(course.id, piano.id, "2026-11-10"))).rejects.toThrow("not one of the course's scheduled weekdays");
  });

  it("a course with no required skills accepts any trainer", async () => {
    const { s, drums } = await seed();
    const open = await s.courses.create({
      title: "Open",
      description: "",
      level: "Beginner",
      price: 100000,
      capacity: 5,
      requiredSkills: [],
      scheduleWeekdays: [1],
      status: "active",
      idempotencyKey: createId(),
    });
    const session = await s.attendance.createSession(sessionOn(open.id, drums.id));
    expect(session.trainerId).toBe(drums.id);
  });
});
