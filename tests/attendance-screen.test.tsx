// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getServices, resetServices } from "@/lib/domain/services";
import { getStorage, resetStorage } from "@/lib/storage";
import { createId } from "@/lib/storage/utils";
import { AttendanceScreen } from "@/components/screens/AttendanceScreen";
import { Providers } from "./support";

// jsdom has no scrollIntoView or pointer capture; the Radix Select calls both when opening.
function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

// This repo has no global testing-library cleanup: unmount each render
// so a later test starts with a clean document.
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

describe("attendance screen session edit and delete", () => {
  it("edits a marked session from the Attendance screen, keeping its marks", async () => {
    stubRadix();
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    // No session picked yet: edit and delete stay disabled.
    expect((scope.getByRole("button", { name: "Edit session" }) as HTMLButtonElement).disabled).toBe(true);
    expect((scope.getByRole("button", { name: "Delete session" }) as HTMLButtonElement).disabled).toBe(true);
    await pickSelect("Course", "Piano");
    await pickSelect("Sessions", /Scales/);
    // The marking list shows the assigned member with the saved mark.
    // ("Ana" also appears in the dashboard table below, so the radiogroup
    // is the precise anchor for the marking row.)
    await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    expect((scope.getByRole("button", { name: "Edit session" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(scope.getByRole("button", { name: "Edit session" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    // Pre-filled from the session, with its trainer still picked.
    expect((within(dialog).getByLabelText("Topic", { exact: true }) as HTMLInputElement).value).toBe("Scales");
    expect((within(dialog).getByRole("radio", { name: /Budi/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Topic", { exact: true }), { target: { value: "Scales 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    // The dialog closes and the reloaded session picker shows the new topic.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sessionTrigger = scope.getByRole("combobox", { name: "Sessions" });
    await waitFor(() => expect(sessionTrigger.textContent).toContain("Scales 2"));
    expect((await s.attendance.getSession(session.id))?.topic).toBe("Scales 2");
    // The saved mark survives the edit, in storage and on screen.
    const rows = await s.attendance.listAttendance(session.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("present");
    const group = scope.getByRole("radiogroup", { name: "Ana" });
    expect((within(group).getByRole("radio", { name: "Present" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("deletes a marked session from the Attendance screen only after confirmation", async () => {
    stubRadix();
    const { s, t, course, members } = await seed();
    const session = await s.attendance.createSession(sessionOn(course.id, t.id, "2026-11-09", "Scales"));
    await s.attendance.assignSessionAttendees(session.id, [members[0].id], createId());
    await s.attendance.mark(session.id, [{ memberId: members[0].id, status: "present" }], createId());
    const { container } = render(
      <Providers>
        <AttendanceScreen navigate={() => {}} />
      </Providers>,
    );
    const scope = within(container);
    await pickSelect("Course", "Piano");
    await pickSelect("Sessions", /Scales/);
    await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    fireEvent.click(scope.getByRole("button", { name: "Delete session" }));
    const confirm = await screen.findByRole("alertdialog", {}, { timeout: 3000 });
    expect(within(confirm).getByText("Delete this session? It will move to the trash bin. You can restore it from there. Its attendance records are removed too.")).toBeTruthy();
    // Cancel keeps the session and its marks.
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await scope.findByRole("radiogroup", { name: "Ana" }, { timeout: 3000 });
    expect(await s.attendance.getSession(session.id)).toBeTruthy();
    fireEvent.click(scope.getByRole("button", { name: "Delete session" }));
    const confirm2 = await screen.findByRole("alertdialog", {}, { timeout: 3000 });
    fireEvent.click(within(confirm2).getByRole("button", { name: "Delete" }));
    // The selection clears and the empty state returns.
    await scope.findByText("No sessions yet", {}, { timeout: 3000 });
    expect(await s.attendance.getSession(session.id)).toBeUndefined();
    expect(await s.attendance.listAttendance(session.id)).toEqual([]);
    // The dashboard reloads with no rows left either.
    await scope.findByText("No attendance records yet.", {}, { timeout: 3000 });
  });
});
