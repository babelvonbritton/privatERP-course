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
    for (const { step } of TOUR_STEPS) {
      for (const messages of [enMessages, idMessages]) {
        const copy = messages.tour.step[step as keyof typeof messages.tour.step];
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("the courses and attendance steps mention session attendee assignment", () => {
    expect(enMessages.tour.step.courses.body).toContain("which members will attend");
    expect(idMessages.tour.step.courses.body).toContain("anggota mana saja yang akan hadir");
    expect(enMessages.tour.step.attendance.body).toContain("assigned member");
    expect(idMessages.tour.step.attendance.body).toContain("yang ditentukan");
  });

  it("does not navigate again for the course-sessions step on the same Courses screen", async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    await screen.findByRole("dialog", {}, { timeout: 3000 });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Courses");
    const calls = onNavigate.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Sessions");
    expect(onNavigate.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
  });

  it("visits each screen once, in sidebar order, with same-screen steps grouped", () => {
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
    const { container } = render(<Harness onNavigate={onNavigate} />);
    const scope = within(container);
    await scope.findByRole("dialog", {}, { timeout: 3000 });
    for (let i = 0; i < 9; i++) fireEvent.click(scope.getByRole("button", { name: "Next" }));
    expect((await scope.findByRole("dialog", {}, { timeout: 3000 })).textContent).toContain("Settings");
    const calls = onNavigate.mock.calls.length;
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
      const { container } = render(<Harness onNavigate={onNavigate} />);
      const scope = within(container);
      const dialog = await scope.findByRole("dialog", {}, { timeout: 3000 });
      expect(dialog.className).toContain("max-h-[45dvh]");
      expect(dialog.className).toContain("rounded-t-[22px]");
      expect(dialog.style.bottom).toBe("56px");
      expect(dialog.querySelector("div[aria-hidden='true'].rounded-full")).not.toBeNull();
      expect(dialog.parentElement?.querySelector(".border-white")).toBeNull();
      expect(scope.getByRole("button", { name: "Next" }).className).toContain("max-sm:h-11");
      expect(scope.getByRole("button", { name: "Skip tour" }).className).toContain("max-sm:min-h-11");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});
