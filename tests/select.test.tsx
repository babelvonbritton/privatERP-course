// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "@/components/ui/Select";

/** Radix Select relies on pointer capture and scrolling, which jsdom does not implement. */
function stubRadix() {
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.hasPointerCapture = function () {
    return false;
  };
  window.HTMLElement.prototype.releasePointerCapture = function () {};
}

afterEach(() => {
  cleanup();
});

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

async function openMenu() {
  const trigger = screen.getByRole("combobox", { name: "Pick one" });
  fireEvent.pointerDown(trigger);
  fireEvent.click(trigger);
  return screen.findByRole("option", { name: "Bravo" });
}

describe("Select scrollToSelectedOnOpen", () => {
  it("caps the menu to the available height when opted in", async () => {
    stubRadix();
    render(<Select value="b" onChange={() => {}} options={options} ariaLabel="Pick one" scrollToSelectedOnOpen />);
    const selected = await openMenu();
    expect(selected.getAttribute("data-state")).toBe("checked");
    expect(screen.getByRole("listbox").className).toContain("max-h-[var(--radix-select-content-available-height)]");
  });

  it("leaves the menu uncapped without the opt-in", async () => {
    stubRadix();
    render(<Select value="b" onChange={() => {}} options={options} ariaLabel="Pick one" />);
    const selected = await openMenu();
    expect(selected.getAttribute("data-state")).toBe("checked");
    expect(screen.getByRole("listbox").className).not.toContain("max-h-[var(--radix-select-content-available-height)]");
  });
});
