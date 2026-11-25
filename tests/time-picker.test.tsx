// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimePicker } from "@/components/ui/TimePicker";
import { Providers } from "./support";

function renderPicker(value: string, onChange = vi.fn()) {
  render(
    <Providers>
      <TimePicker value={value} onChange={onChange} ariaLabel="Start time" />
    </Providers>,
  );
  return { onChange };
}

describe("TimePicker", () => {
  afterEach(() => cleanup());

  it("shows the current value and opens the hour and minute columns", async () => {
    renderPicker("09:00");
    expect(screen.getByRole("button", { name: "Start time" }).textContent).toContain("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    expect(await screen.findByRole("group", { name: "Hour" })).toBeTruthy();
    expect(await screen.findByRole("group", { name: "Minute" })).toBeTruthy();
    const hour = screen.getByRole("group", { name: "Hour" });
    expect((hour.querySelectorAll("button")[9] as HTMLElement).getAttribute("aria-pressed")).toBe("true");
  });

  it("picking an hour then a minute round-trips the HH:MM value and closes the panel", async () => {
    const { onChange } = renderPicker("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    const hour = await screen.findByRole("group", { name: "Hour" });
    fireEvent.click(hour.querySelectorAll("button")[10]);
    expect(onChange).toHaveBeenLastCalledWith("10:00");
    const minute = screen.getByRole("group", { name: "Minute" });
    fireEvent.click(minute.querySelectorAll("button")[30]);
    expect(onChange).toHaveBeenLastCalledWith("09:30");
    expect(screen.queryByRole("group", { name: "Hour" })).toBeNull();
  });

  it("every minute is pickable, so stored times round-trip exactly", async () => {
    const { onChange } = renderPicker("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    const minute = await screen.findByRole("group", { name: "Minute" });
    fireEvent.click(minute.querySelectorAll("button")[7]);
    expect(onChange).toHaveBeenLastCalledWith("09:07");
  });

  it("arrow keys move focus inside a column and Enter picks", async () => {
    const { onChange } = renderPicker("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    const hour = await screen.findByRole("group", { name: "Hour" });
    const buttons = hour.querySelectorAll("button");
    (buttons[9] as HTMLElement).focus();
    expect(document.activeElement).toBe(buttons[9]);
    fireEvent.keyDown(buttons[9], { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[10]);
    fireEvent.keyDown(buttons[10], { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[9]);
    fireEvent.keyDown(buttons[9], { key: "End" });
    expect(document.activeElement).toBe(buttons[23]);
    fireEvent.keyDown(buttons[23], { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith("00:00");
  });

  it("Done closes the panel without changing the value", async () => {
    const { onChange } = renderPicker("09:00");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Hour" })).toBeNull();
  });

  it("an unusable value shows the pick prompt and still opens at 09:00", async () => {
    renderPicker("");
    expect(screen.getByRole("button", { name: "Start time" }).textContent).toContain("Pick a time");
    fireEvent.click(screen.getByRole("button", { name: "Start time" }));
    const hour = await screen.findByRole("group", { name: "Hour" });
    expect((hour.querySelectorAll("button")[9] as HTMLElement).getAttribute("aria-pressed")).toBe("true");
  });

  it("labels are bilingual", async () => {
    render(
      <Providers locale="id">
        <TimePicker value="09:00" onChange={() => {}} ariaLabel="Waktu mulai" />
      </Providers>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Waktu mulai" }));
    expect(await screen.findByRole("group", { name: "Jam" })).toBeTruthy();
    expect(await screen.findByRole("group", { name: "Menit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Selesai" })).toBeTruthy();
  });
});
