// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TourProvider, useTour } from "@/components/Tour";
import type { NavId } from "@/components/nav";
import { getStorage, resetStorage } from "@/lib/storage";
import { resetServices } from "@/lib/domain/services";
import { Providers } from "./support";

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
