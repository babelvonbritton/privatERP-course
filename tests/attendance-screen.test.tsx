// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { AttendanceScreen } from "@/components/screens/AttendanceScreen";
import { Toaster } from "@/components/Toaster";
import { Providers } from "./support";

function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

afterEach(() => cleanup());

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

/** Opens a Radix Select by its accessible name and picks an option. The Attendance screen has two "Course" selects (picker, then dashboard filter); the picker is the first. */
async function pickSelect(label: string, option: RegExp | string, index = 0) {
  const triggers = await screen.findAllByRole("combobox", { name: label }, { timeout: 3000 });
  const trigger = triggers[index];
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }, { timeout: 3000 }));
}

describe("removeSession", () => {
  it("removes a marked session and its attendance rows, keeping them in the trash entry", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    expect((await s.attendance.listAttendance(session.id)).length).toBe(1);
    await s.attendance.removeSession(session.id);
    expect(await s.attendance.getSession(session.id)).toBeUndefined();
    expect(await s.attendance.listAttendance(session.id)).toEqual([]);
    const entries = await s.trash.list();
    const entry = entries.find((e) => e.kind === "session" && e.originalId === session.id);
    expect(entry).toBeTruthy();
    expect(entry?.related.length).toBe(1);
  });
});

describe("unmarkSession", () => {
  it("clears a marked session's rows and returns it to the unmarked list", async () => {
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    expect((await s.attendance.listUnmarkedSessions()).map((x) => x.id)).not.toContain(session.id);
    await s.attendance.unmarkSession(session.id);
    expect(await s.attendance.listAttendance(session.id)).toEqual([]);
    expect(await s.attendance.getSession(session.id)).toBeTruthy();
    expect((await s.attendance.listUnmarkedSessions()).map((x) => x.id)).toContain(session.id);
  });
});

describe("attendance screen session list", () => {
  async function seedMarked() {
    const { s, t, course, members } = await seed();
    const marked = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    await s.attendance.assignSessionAttendees(marked.id, [members[0].id], createId());
    await s.attendance.mark(marked.id, [{ memberId: members[0].id, status: "present" }], createId());
    await s.attendance.setTrainerPresent(marked.id, true, createId());
    const open = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-02", "Arpeggios"));
    return { s, t, course, members, marked, open };
  }

  it("picking a course shows its session list, soonest first, with a marked indicator and no session-management buttons", async () => {
    stubRadix();
    const { course } = await seedMarked();
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    const list = await scope.findByRole("region", { name: "Sessions" }, { timeout: 3000 });
    const rows = within(list).getAllByRole("button");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Arpeggios");
    expect(rows[1].textContent).toContain("Scales");
    expect(within(rows[1]).getByText("Marked")).toBeTruthy();
    expect(within(rows[0]).queryByText("Marked")).toBeNull();
    expect(scope.queryByRole("button", { name: "New session" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Edit session" })).toBeNull();
    expect(scope.queryByRole("button", { name: "Delete session" })).toBeNull();
    expect(course).toBeTruthy();
  });

  it("a course with no sessions shows the empty state", async () => {
    stubRadix();
    await seed();
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    await scope.findByText("No sessions for this course yet.", {}, { timeout: 3000 });
    expect(scope.getByText("Add sessions from the Sessions section on the Courses screen.")).toBeTruthy();
  });

  it("picking a marked session shows its saved marks", async () => {
    stubRadix();
    await seedMarked();
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    fireEvent.click(await scope.findByRole("button", { name: /Scales/ }, { timeout: 3000 }));
    const group = await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    expect((within(group).getByRole("radio", { name: "Present" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect((scope.getByRole("switch", { name: "Trainer present" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("saving adjusted marks updates them and the session stays marked", async () => {
    stubRadix();
    const { s, marked } = await seedMarked();
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
        <Toaster />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    fireEvent.click(await scope.findByRole("button", { name: /Scales/ }, { timeout: 3000 }));
    const group = await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    fireEvent.click(within(group).getByRole("radio", { name: "Absent" }));
    fireEvent.click(scope.getByRole("button", { name: "Mark attendance" }));
    await screen.findByText("Attendance saved", {}, { timeout: 3000 });
    const rows = await s.attendance.listAttendance(marked.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("absent");
    expect(within(scope.getByRole("button", { name: /Scales/ })).getByText("Marked")).toBeTruthy();
  });

  it("the unmark control shows only for marked sessions and clears the marks after confirmation", async () => {
    stubRadix();
    const { s, marked } = await seedMarked();
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
        <Toaster />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    fireEvent.click(await scope.findByRole("button", { name: /Arpeggios/ }, { timeout: 3000 }));
    await scope.findByText("No member assigned to this session.", {}, { timeout: 3000 });
    expect(scope.queryByRole("button", { name: "Unmark session" })).toBeNull();
    fireEvent.click(scope.getByRole("button", { name: /Scales/ }));
    await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    fireEvent.click(scope.getByRole("button", { name: "Unmark session" }));
    const confirm = await screen.findByRole("alertdialog", {}, { timeout: 3000 });
    expect(within(confirm).getByText("Unmark this session? Its attendance will be cleared and it will return to the Sessions list.")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((await s.attendance.listAttendance(marked.id)).length).toBe(1);
    fireEvent.click(scope.getByRole("button", { name: "Unmark session" }));
    const confirm2 = await screen.findByRole("alertdialog", {}, { timeout: 3000 });
    fireEvent.click(within(confirm2).getByRole("button", { name: "Unmark session" }));
    await screen.findByText("Attendance cleared", {}, { timeout: 3000 });
    expect(await s.attendance.listAttendance(marked.id)).toEqual([]);
    expect((await s.attendance.listUnmarkedSessions()).map((x) => x.id)).toContain(marked.id);
    expect(within(scope.getByRole("button", { name: /Scales/ })).queryByText("Marked")).toBeNull();
  });
});
