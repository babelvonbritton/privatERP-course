// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TourProvider, TOUR_STEPS, useTour } from "@/components/Tour";
import { NAV_ITEMS, type NavId } from "@/components/nav";
import { getStorage, resetStorage } from "@/lib/storage";
import { resetServices } from "@/lib/domain/services";
import { Providers } from "./support";
import enMessages from "../messages/en.json";
import idMessages from "../messages/id.json";

async function freshStorage() {
  await resetStorage();
  resetServices();
}

function Harness({ onNavigate }: { onNavigate: (id: NavId) => void }) {
  return (
    <Providers>
      <TourProvider navigate={onNavigate}>
        <div data-tour="dashboard">
          <h1>Dashboard</h1>
        </div>
        <div data-tour="members">
          <h1>Members</h1>
        </div>
      </TourProvider>
    </Providers>
  );
}

function ReplayButton() {
  const { startTour } = useTour();
  return (
    <button type="button" onClick={startTour}>
      Replay tour
    </button>
  );
}

function ReplayHarness() {
  return (
    <Providers>
      <TourProvider navigate={() => {}}>
        <div data-tour="dashboard">
          <h1>Dashboard</h1>
        </div>
        <ReplayButton />
      </TourProvider>
    </Providers>
  );
}

describe("tour", () => {
  beforeEach(async () => {
    await freshStorage();
  });

  it("auto-shows on first run, advances with Next, and Skip ends the whole tour", async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);

    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    expect(dialog.textContent).toContain("Dashboard");
    expect(onNavigate).toHaveBeenCalledWith("dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNavigate).toHaveBeenCalledWith("members");
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Members");

    // Skip on any step ends the entire tour: no dialog, and it never auto-shows again.
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await getStorage().preferences.load()).preferences.tourSeen).toBe(true);
  });

  it("does not auto-show once the tour was seen", async () => {
    await getStorage().preferences.set("tourSeen", true);
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("replays from the start on demand", async () => {
    await getStorage().preferences.set("tourSeen", true);
    render(<ReplayHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replay tour" }));
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Dashboard");
  });

  it("every tour step has title and body copy in English and Indonesian", () => {
    // The overlay looks the copy up by step id at runtime, so a missing key
    // would render as a bare key instead of failing loudly.
    for (const { step } of TOUR_STEPS) {
      for (const messages of [enMessages, idMessages]) {
        const copy = messages.tour.step[step as keyof typeof messages.tour.step];
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("the courses and attendance steps mention session attendee assignment", () => {
    // The assignment lives in the course menu: the courses step names it,
    // and the attendance step says marking only covers the assigned members.
    expect(enMessages.tour.step.courses.body).toContain("which members will attend");
    expect(idMessages.tour.step.courses.body).toContain("anggota mana saja yang akan hadir");
    expect(enMessages.tour.step.attendance.body).toContain("assigned member");
    expect(idMessages.tour.step.attendance.body).toContain("yang ditentukan");
  });

  it("does not navigate again for the course-sessions step on the same Courses screen", async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    await screen.findByRole("dialog", {}, { timeout: 3000 });
    // Walk to the courses step (3 Next taps from the dashboard).
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Courses");
    const calls = onNavigate.mock.calls.length;
    // The Sessions section sits below the course table on the same screen:
    // no further navigation (a redundant navigate would scroll back to the
    // top after the overlay scrolled the section into view).
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Sessions");
    expect(onNavigate.mock.calls.length).toBe(calls);
    // End the tour so this harness leaves no open dialog behind for later tests.
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
  });

  it("visits each screen once, in sidebar order, with same-screen steps grouped", () => {
    // One clean forward pass: the nav sequence never goes backward, so no
    // screen is revisited and no step re-navigates to an earlier screen.
    const order = new Map(NAV_ITEMS.map((item, i) => [item.id, i]));
    const navs = TOUR_STEPS.map(({ nav }) => order.get(nav)!);
    for (let i = 1; i < navs.length; i++) expect(navs[i]).toBeGreaterThanOrEqual(navs[i - 1]);
    expect(TOUR_STEPS.map(({ step }) => step)).toEqual([
      "dashboard",
      "members",
      "trainers",
      "courses",
      "courseSessions",
      "attendance",
      "invoices",
      "payroll",
      "trash",
      "settings",
      "profile",
      "drive",
    ]);
  });

  it("does not navigate again for the profile and Drive steps on the same Settings screen", async () => {
    const onNavigate = vi.fn();
    // Scope every query to this render: earlier tests in this file leave
    // their trees mounted (no auto-cleanup in this suite), so a global
    // getByRole could hit another test's dialog.
    const { container } = render(<Harness onNavigate={onNavigate} />);
    const scope = within(container);
    await scope.findByRole("dialog", {}, { timeout: 3000 });
    // Walk to the settings step (9 Next taps from the dashboard).
    for (let i = 0; i < 9; i++) fireEvent.click(scope.getByRole("button", { name: "Next" }));
    expect((await scope.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Settings");
    const calls = onNavigate.mock.calls.length;
    // The profile section sits at the top of Settings, so it comes before
    // the Drive section below it: the tour walks the screen top to bottom
    // instead of scrolling down and back up. Neither step navigates again
    // (a redundant navigate would scroll back to the top after the overlay
    // scrolled the section into view, pushing the tooltip off-screen).
    fireEvent.click(scope.getByRole("button", { name: "Next" }));
    expect((await scope.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Business profile");
    expect(onNavigate.mock.calls.length).toBe(calls);
    fireEvent.click(scope.getByRole("button", { name: "Next" }));
    expect((await scope.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Google Drive");
    expect(onNavigate.mock.calls.length).toBe(calls);
  });

  it("renders as a bottom sheet on a narrow screen, with no highlight ring", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      const onNavigate = vi.fn();
      // Scope every query to this render: earlier tests in this file leave
      // their trees mounted (no auto-cleanup in this suite), so a global
      // findByRole could return another test's desktop dialog.
      const { container } = render(<Harness onNavigate={onNavigate} />);
      const scope = within(container);
      const dialog = await scope.findByRole("dialog", {}, { timeout: 3000 });
      // Full-width sheet capped at 45dvh, docked above the bottom bar (no bar
      // in this harness, so the 56px fallback applies).
      expect(dialog.className).toContain("max-h-[45dvh]");
      expect(dialog.className).toContain("rounded-t-[22px]");
      expect(dialog.style.bottom).toBe("56px");
      // Visible grabber handle at the top of the sheet.
      expect(dialog.querySelector("div[aria-hidden='true'].rounded-full")).not.toBeNull();
      // No whole-screen highlight ring: nothing in the overlay carries its border.
      expect(dialog.parentElement?.querySelector(".border-white")).toBeNull();
      // Sheet buttons are fingertip-sized on a phone.
      expect(scope.getByRole("button", { name: "Next" }).className).toContain("max-sm:h-11");
      expect(scope.getByRole("button", { name: "Skip tour" }).className).toContain("max-sm:min-h-11");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});
