// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimezoneSection } from "@/components/settings/TimezoneSection";
import { deviceTimezone, getTimezone, resetTimezone } from "@/lib/timezone";
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
    const current = await screen.findByRole("option", { name: `${device} (UTC+00:00)` });
    expect(current.getAttribute("data-state")).toBe("checked");
    fireEvent.click(await screen.findByRole("option", { name: "Asia/Jakarta (UTC+07:00)" }));
    await waitFor(() => expect(getTimezone()).toBe("Asia/Jakarta"));
    const { preferences } = await getStorage().preferences.load();
    expect(preferences.timezone).toBe("Asia/Jakarta");
  }, 15000);
});
