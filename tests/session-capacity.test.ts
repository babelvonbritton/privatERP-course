// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { isAttendingStatus, parseSessionCapacity, sessionCapacity } from "@/lib/domain/types";

async function freshServices() {
  await resetStorage();
  resetServices();
  return getServices();
}

const trainer = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000001",
  subjects: ["Piano"],
  ratePerSession: 100000,
  status: "active" as const,
  idempotencyKey: createId(),
});

const member = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  phone: "0812000000",
  notes: "",
  status: "active" as const,
  idempotencyKey: createId(),
});

/** 2026-11-02 and 2026-11-09 are Mondays, on the course's slot. */
async function seed() {
  const s = await freshServices();
  const t = await s.trainers.create(trainer("Budi"));
  const course = await s.courses.create({
    title: "Piano",
    description: "",
    level: "Beginner",
    price: 100000,
    requiredSkills: [],
    scheduleWeekdays: [1],
    status: "active",
    idempotencyKey: createId(),
  });
  const members = [];
  for (const name of ["Ana", "Budi", "Cici"]) {
    const m = await s.members.create(member(name));
    await s.courses.enroll({ memberId: m.id, courseId: course.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    members.push(m);
  }
  return { s, t, course, members };
}

const sessionOn = (courseId: string, trainerId: string, date: string, topic: string, capacity?: number | null) => ({
  courseId,
  date,
  topic,
  trainerId,
  trainerPresent: false,
  startTime: "09:00",
  endTime: "10:00",
  ...(capacity === undefined ? {} : { capacity }),
  idempotencyKey: createId(),
});

async function expectSessionFull(promise: Promise<unknown>, attending: number, capacity: number) {
  try {
    await promise;
    expect.unreachable("marking past the cap must be rejected");
  } catch (e) {
    const err = e as { kind?: string; vars?: Record<string, string | number> };
    expect(err?.kind).toBe("sessionFull");
    expect(err?.vars?.attending).toBe(attending);
    expect(err?.vars?.capacity).toBe(capacity);
  }
}

describe("session capacity", () => {
  it("cap reached rejects the next attending mark and leaves nothing half-saved", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 1));
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    await expectSessionFull(
      s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId()),
      2,
      1,
    );
    const rows = await s.attendance.listAttendance(session.id);
    expect(rows.map((r) => `${r.memberId}:${r.status}`)).toEqual([`${members[0].id}:present`]);
  });

  it("absent does not count toward the cap, and late does", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 1));
    await s.attendance.mark(session.id, [{ memberId: members[1].id, status: "absent" }], createId());
    await s.attendance.mark(session.id, [{ memberId: members[2].id, status: "absent" }], createId());
    // Only absent marks so far: a late mark still fits.
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "late" }], createId());
    await expectSessionFull(
      s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId()),
      2,
      1,
    );
  });

  it("switching a member to absent frees their place", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 1));
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "absent" }], createId());
    const rows = await s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId());
    expect(rows.find((r) => r.memberId === members[1].id)?.status).toBe("present");
  });

  it("a batch that would overflow is rejected whole", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 1));
    await expectSessionFull(
      s.attendance.mark(
        session.id,
        [
          { memberId: members[0].id, status: "present" },
          { memberId: members[1].id, status: "present" },
        ],
        createId(),
      ),
      2,
      1,
    );
    expect(await s.attendance.listAttendance(session.id)).toEqual([]);
  });

  it("a session with no capacity is uncapped", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Open"));
    const rows = await s.attendance.mark(
      session.id,
      members.map((m) => ({ memberId: m.id, status: "present" as const })),
      createId(),
    );
    expect(rows).toHaveLength(3);
  });

  it("creating a session stores its cap, and a blank cap stores none", async () => {
    const { s, t, course } = await seed();
    const capped = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 2));
    expect(capped.capacity).toBe(2);
    const open = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-16", "Open"));
    expect(open.capacity ?? null).toBeNull();
  });

  it("helpers: blank parses to no cap, whole numbers parse, anything else is invalid", () => {
    expect(parseSessionCapacity("")).toBeNull();
    expect(parseSessionCapacity("   ")).toBeNull();
    expect(parseSessionCapacity("3")).toBe(3);
    expect(parseSessionCapacity(" 2 ")).toBe(2);
    expect(parseSessionCapacity("0")).toBeUndefined();
    expect(parseSessionCapacity("-1")).toBeUndefined();
    expect(parseSessionCapacity("1.5")).toBeUndefined();
    expect(parseSessionCapacity("many")).toBeUndefined();
    expect(sessionCapacity({ capacity: 2 })).toBe(2);
    expect(sessionCapacity({})).toBeNull();
    expect(sessionCapacity({ capacity: null })).toBeNull();
    expect(sessionCapacity({ capacity: 0 })).toBeNull();
    expect(isAttendingStatus("present")).toBe(true);
    expect(isAttendingStatus("late")).toBe(true);
    expect(isAttendingStatus("absent")).toBe(false);
  });
});
