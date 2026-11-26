// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimezoneSection } from "@/components/settings/TimezoneSection";
import { deviceTimezone, getTimezone, resetTimezone, zoneLabel } from "@/lib/timezone";
import { getStorage, resetStorage } from "@/lib/storage";
import { Providers } from "./support";

afterEach(() => {
  cleanup();
  resetTimezone();
});

/** Radix Select relies on pointer capture and scrolling, which jsdom does not implement. */
function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

describe("TimezoneSection", () => {
  // Renders a 418-option menu, so it needs more time under parallel load.
  it("shows the device timezone by default and saves a pick", async () => {
    stubRadix();
    await resetStorage();
    render(
      <Providers>
        <TimezoneSection />
      </Providers>,
    );
    const device = deviceTimezone();
    const trigger = screen.getByRole("combobox", { name: "Local timezone" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    // The device zone's label carries its own offset, so the test holds on
    // any machine, not just one set to UTC.
    const current = await screen.findByRole("option", { name: zoneLabel(device) });
    expect(current.getAttribute("data-state")).toBe("checked");
    fireEvent.click(await screen.findByRole("option", { name: "Asia/Jakarta (UTC+07:00)" }));
    await waitFor(() => expect(getTimezone()).toBe("Asia/Jakarta"));
    const { preferences } = await getStorage().preferences.load();
    expect(preferences.timezone).toBe("Asia/Jakarta");
    // Reopening shows the newly selected zone as the checked option, and the
    // long menu is capped to the space available so the list can scroll to
    // it. Whether the option is actually in view is a layout fact, so the
    // browser check asserts it in a real browser.
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    const jakarta = await screen.findByRole("option", { name: "Asia/Jakarta (UTC+07:00)" });
    expect(jakarta.getAttribute("data-state")).toBe("checked");
    expect(screen.getByRole("listbox").className).toContain("max-h-[var(--radix-select-content-available-height)]");
  }, 15000);
});
