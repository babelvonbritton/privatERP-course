// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BackupValidator } from "@/lib/backup/BackupValidator";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { sessionAttendees, sessionEffectiveAttendees } from "@/lib/domain/types";
import { CoursesScreen } from "@/components/screens/CoursesScreen";
import { Providers } from "./support";

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
  const enrollments = [];
  for (const name of ["Ana", "Budi", "Cici"]) {
    const m = await s.members.create(member(name));
    const e = await s.courses.enroll({ memberId: m.id, courseId: course.id, startDate: "2026-11-02", endDate: null, status: "active", idempotencyKey: createId() });
    members.push(m);
    enrollments.push(e);
  }
  return { s, t, course, members, enrollments };
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

async function expectValidationKind(promise: Promise<unknown>, kind: string) {
  try {
    await promise;
    expect.unreachable("the write must be rejected");
  } catch (e) {
    expect((e as { kind?: string }).kind).toBe(kind);
  }
}

describe("session attendee assignment", () => {
  it("a new session starts unassigned and covers every enrolled member", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Open"));
    expect(session.attendeeMemberIds ?? null).toBeNull();
    expect(sessionAttendees(session)).toBeNull();
    expect(sessionEffectiveAttendees(session, members.map((m) => m.id))).toEqual(members.map((m) => m.id));
    const rows = await s.attendance.mark(
      session.id,
      members.map((m) => ({ memberId: m.id, status: "present" as const })),
      createId(),
    );
    expect(rows).toHaveLength(3);
  });

  it("assigning members stores the list and narrows the effective list", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Assigned"));
    const assigned = await s.attendance.assignSessionAttendees(session.id, [members[0].id, members[2].id], createId());
    expect(assigned.attendeeMemberIds).toEqual([members[0].id, members[2].id]);
    const stored = await s.attendance.getSession(session.id);
    expect(sessionAttendees(stored!)).toEqual([members[0].id, members[2].id]);
    expect(sessionEffectiveAttendees(stored!, members.map((m) => m.id))).toEqual([members[0].id, members[2].id]);
  });

  it("assigning nobody clears the assignment back to unassigned", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Assigned"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    const cleared = await s.attendance.assignSessionAttendees(session.id, [], createId());
    expect(cleared.attendeeMemberIds).toBeNull();
    expect(sessionEffectiveAttendees(cleared, members.map((m) => m.id))).toEqual(members.map((m) => m.id));
  });

  it("assigning a member who is not enrolled is rejected and changes nothing", async () => {
    const { s, t, course, members } = await seed();
    const outsider = await s.members.create(member("Dedi"));
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Assigned"));
    await expectValidationKind(
      s.attendance.assignSessionAttendees(session.id, [members[0].id, outsider.id], createId()),
      "notEnrolled",
    );
    expect((await s.attendance.getSession(session.id))?.attendeeMemberIds ?? null).toBeNull();
  });

  it("marking a member outside the assigned list is rejected, an assigned member marks fine", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Assigned"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    await expectValidationKind(
      s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId()),
      "notAssigned",
    );
    const rows = await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    expect(rows).toHaveLength(1);
    expect(await s.attendance.listAttendance(session.id)).toHaveLength(1);
  });

  it("marking a member who is not enrolled is rejected", async () => {
    const { s, t, course, members } = await seed();
    const outsider = await s.members.create(member("Dedi"));
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Open"));
    await expectValidationKind(
      s.attendance.mark(session.id, [{ memberId: outsider.id, status: "present" }], createId()),
      "notEnrolled",
    );
    expect(members.length).toBe(3);
  });

  it("an assigned member who leaves the course drops out of the effective list", async () => {
    const { s, t, course, members, enrollments } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Assigned"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id, members[1].id], createId());
    await s.courses.updateEnrollment(enrollments[1].id, { status: "cancelled", idempotencyKey: createId() });
    const stored = await s.attendance.getSession(session.id);
    const stillEnrolled = (await s.courses.listEnrollmentsByCourse(course.id)).filter((e) => e.status === "active").map((e) => e.memberId);
    expect(sessionEffectiveAttendees(stored!, stillEnrolled)).toEqual([members[0].id]);
    await expectValidationKind(
      s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId()),
      "notEnrolled",
    );
  });

  it("the capacity cap still applies to an assigned session", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Capped", 1));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id, members[1].id], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    try {
      await s.attendance.mark(session.id, [{ memberId: members[1].id, status: "present" }], createId());
      expect.unreachable("marking past the cap must be rejected");
    } catch (e) {
      const err = e as { kind?: string; vars?: Record<string, string | number> };
      expect(err?.kind).toBe("sessionFull");
      expect(err?.vars?.attending).toBe(2);
      expect(err?.vars?.capacity).toBe(1);
    }
  });

  it("a legacy session row without the field loads as unassigned, with no Dexie migration", async () => {
    const { s, t, course, members } = await seed();
    // A row written before attendee assignment existed carries no field at all.
    const legacy = {
      id: createId(),
      orgId: "Olaseena",
      ownerId: "owner",
      createdAt: 1000,
      updatedAt: 1000,
      rev: 1,
      courseId: course.id,
      date: "2026-11-09",
      topic: "Legacy",
      trainerId: t.id,
      trainerPresent: false,
      startTime: "09:00",
      endTime: "10:00",
      capacity: null,
    };
    await getStorage().db.sessions.put(legacy as never);
    const loaded = await s.attendance.getSession(legacy.id);
    expect(loaded).toBeDefined();
    expect(sessionAttendees(loaded!)).toBeNull();
    expect(sessionEffectiveAttendees(loaded!, members.map((m) => m.id))).toEqual(members.map((m) => m.id));
    const rows = await s.attendance.mark(
      legacy.id,
      members.map((m) => ({ memberId: m.id, status: "present" as const })),
      createId(),
    );
    expect(rows).toHaveLength(3);
  });

  it("helpers: missing or null means unassigned, duplicates and blanks are dropped", () => {
    expect(sessionAttendees({})).toBeNull();
    expect(sessionAttendees({ attendeeMemberIds: null })).toBeNull();
    expect(sessionAttendees({ attendeeMemberIds: ["a", "b", "a", "", "c"] })).toEqual(["a", "b", "c"]);
    // A malformed row (not a list at all) is tolerated at runtime, like the capacity helper does.
    expect(sessionAttendees({ attendeeMemberIds: "not-a-list" } as never)).toBeNull();
    expect(sessionEffectiveAttendees({}, ["a", "b"])).toEqual(["a", "b"]);
    expect(sessionEffectiveAttendees({ attendeeMemberIds: ["b", "gone"] }, ["a", "b"])).toEqual(["b"]);
  });
});

describe("session attendees in backups", () => {
  function rawBackup(session: Record<string, unknown>) {
    return {
      members: [
        { id: "member-1", orgId: "Olaseena", ownerId: "owner", name: "Ana", email: "ana@example.com", phone: "0812000000", notes: "", status: "active", createdAt: 1000, updatedAt: 1000, rev: 1 },
        { id: "member-2", orgId: "Olaseena", ownerId: "owner", name: "Budi", email: "budi@example.com", phone: "0812000001", notes: "", status: "active", createdAt: 1000, updatedAt: 1000, rev: 1 },
      ],
      trainers: [{ id: "trainer-1", orgId: "Olaseena", ownerId: "owner", name: "Budi", email: "budi@example.com", phone: "0812000001", subjects: ["Piano"], ratePerSession: 100000, status: "active", createdAt: 1000, updatedAt: 1000, rev: 1 }],
      courses: [{ id: "course-1", orgId: "Olaseena", ownerId: "owner", title: "Piano", description: "", level: "Beginner", price: 100000, requiredSkills: [], scheduleWeekdays: [1], status: "active", createdAt: 1000, updatedAt: 1000, rev: 1 }],
      enrollments: [],
      sessions: [session],
      attendance: [],
      invoices: [],
      payments: [],
      payrollRuns: [],
      auditLog: [],
      writeKeys: [],
      settings: [],
    };
  }

  const baseSession = {
    id: "session-1",
    orgId: "Olaseena",
    ownerId: "owner",
    courseId: "course-1",
    date: "2026-11-09",
    topic: "Assigned",
    trainerId: "trainer-1",
    trainerPresent: false,
    startTime: "09:00",
    endTime: "10:00",
    capacity: null,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 1,
  };

  it("a session with assigned members round-trips, with no unknown-field warning", () => {
    const result = BackupValidator.validateData(rawBackup({ ...baseSession, attendeeMemberIds: ["member-1", "member-2"] }));
    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.sessions[0].attendeeMemberIds).toEqual(["member-1", "member-2"]);
    expect(result.warnings).toEqual([]);
  });

  it("a legacy backup session without the field restores as unassigned", () => {
    const result = BackupValidator.validateData(rawBackup({ ...baseSession }));
    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.sessions[0].attendeeMemberIds ?? null).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("an attendee id pointing at a missing member fails validation", () => {
    try {
      BackupValidator.validateData(rawBackup({ ...baseSession, attendeeMemberIds: ["member-1", "ghost"] }));
      expect.unreachable("a dangling attendee id must fail validation");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("BACKUP_STRUCTURE_INVALID");
    }
  });
});

describe("unmarked sessions", () => {
  it("lists only unmarked sessions, any date, soonest first; a marked session leaves the list", async () => {
    const { s, t, course, members } = await seed();
    const past = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-10-26", "Past"));
    const later = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-16", "Later"));
    const soon = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Soon"));
    // A past session that was never marked still waits to be marked.
    let pending = await s.attendance.listUnmarkedSessions();
    expect(pending.map((x) => x.topic)).toEqual(["Past", "Soon", "Later"]);
    // One mark is enough: the service accepts partial marks, so done means
    // at least one attendance row, not a full batch.
    await s.attendance.mark(soon.id, [{ memberId: members[0].id, status: "present" }], createId());
    pending = await s.attendance.listUnmarkedSessions();
    expect(pending.map((x) => x.topic)).toEqual(["Past", "Later"]);
    await s.attendance.mark(
      past.id,
      members.map((m) => ({ memberId: m.id, status: "present" as const })),
      createId(),
    );
    pending = await s.attendance.listUnmarkedSessions();
    expect(pending.map((x) => x.topic)).toEqual(["Later"]);
  });
});

describe("course menu session list", () => {
  it("assigns members from the Sessions section below the course table and returns to all enrolled when all are unchecked", async () => {
    const { s, t, course } = await seed();
    await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    const { container } = render(
      <Providers>
        <CoursesScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    await scope.findByRole("region", { name: "Courses" }, { timeout: 3000 });
    const pending = await scope.findByRole("region", { name: "Sessions to mark" }, { timeout: 3000 });
    // The row names the course it belongs to, and a fresh session lists every enrolled member.
    await within(pending).findByText(/Scales/, {}, { timeout: 3000 });
    expect(within(pending).getByText("Piano")).toBeTruthy();
    expect(within(pending).getByText("All enrolled members")).toBeTruthy();
    fireEvent.click(within(pending).getByRole("button", { name: "Assign members" }));
    expect(within(pending).getByRole("checkbox", { name: "Ana" })).toBeTruthy();
    expect(within(pending).getByRole("checkbox", { name: "Budi" })).toBeTruthy();
    expect(within(pending).getByRole("checkbox", { name: "Cici" })).toBeTruthy();
    fireEvent.click(within(pending).getByRole("checkbox", { name: "Ana" }));
    fireEvent.click(within(pending).getByRole("button", { name: "Save changes" }));
    await within(pending).findByText("Assigned: Ana", {}, { timeout: 3000 });
    // Unchecking the only assigned member returns the session to unassigned.
    fireEvent.click(within(pending).getByRole("button", { name: "Assign members" }));
    expect((within(pending).getByRole("checkbox", { name: "Ana" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(pending).getByRole("checkbox", { name: "Ana" }));
    fireEvent.click(within(pending).getByRole("button", { name: "Save changes" }));
    await within(pending).findByText("All enrolled members", {}, { timeout: 3000 });
  });

  it("a marked session leaves the section and an unmarked one stays, in date order", async () => {
    const { s, t, course, members } = await seed();
    const marked = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Marked"));
    await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-16", "Waiting"));
    await s.attendance.mark(
      marked.id,
      members.map((m) => ({ memberId: m.id, status: "present" as const })),
      createId(),
    );
    const { container } = render(
      <Providers>
        <CoursesScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    const pending = await scope.findByRole("region", { name: "Sessions to mark" }, { timeout: 3000 });
    await within(pending).findByText(/Waiting/, {}, { timeout: 3000 });
    expect(within(pending).queryByText(/Marked/)).toBeNull();
  });

  it("the section renders even with no courses, so the tour target always exists", async () => {
    await freshServices();
    const { container } = render(
      <Providers>
        <CoursesScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    const pending = await scope.findByRole("region", { name: "Sessions to mark" }, { timeout: 3000 });
    expect(within(pending).getByText("No sessions waiting to be marked. Once a session is marked, it leaves this list.")).toBeTruthy();
  });

  it("the course-detail session list no longer offers assignment", async () => {
    const { s, t, course } = await seed();
    await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    const { container } = render(
      <Providers>
        <CoursesScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    const table = await scope.findByRole("region", { name: "Courses" }, { timeout: 3000 });
    fireEvent.click(within(table).getByText("Piano"));
    // The detail is a Radix dialog, portaled to the body outside the render container.
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    // The detail still lists the course's sessions, with the assigned status, but no assign control.
    await within(dialog).findByText(/Scales/, {}, { timeout: 3000 });
    expect(within(dialog).getByText("All enrolled members")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Assign members" })).toBeNull();
  });
});
