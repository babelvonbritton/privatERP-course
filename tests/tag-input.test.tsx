// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TagInput } from "@/components/ui/TagInput";
import { Providers } from "./support";

function renderInput(value: string[], onChange = vi.fn(), suggestions = ["Piano", "Guitar", "Violin"]) {
  render(
    <Providers>
      <TagInput id="skills" value={value} onChange={onChange} suggestions={suggestions} placeholder="Type a skill…" />
    </Providers>,
  );
  return { onChange, input: screen.getByRole("combobox") };
}

describe("TagInput", () => {
  afterEach(() => cleanup());

  it("suggests an existing skill as you type and adds it on click", async () => {
    const { onChange, input } = renderInput([]);
    fireEvent.change(input, { target: { value: "pia" } });
    expect(await screen.findByRole("option", { name: "Piano" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("option", { name: "Piano" }));
    fireEvent.click(screen.getByRole("option", { name: "Piano" }));
    expect(onChange).toHaveBeenCalledWith(["Piano"]);
  });

  it("creates a new skill with Enter and offers it as the add row", async () => {
    const { onChange, input } = renderInput([]);
    fireEvent.change(input, { target: { value: "Cello" } });
    expect(await screen.findByRole("option", { name: "Add “Cello”" })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["Cello"]);
  });

  it("dedupes case-insensitively: typing an existing skill again adds nothing", async () => {
    const { onChange, input } = renderInput(["Piano"]);
    fireEvent.change(input, { target: { value: "piano" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes a chip with its remove button", () => {
    const { onChange } = renderInput(["Piano", "Guitar"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Piano" }));
    expect(onChange).toHaveBeenCalledWith(["Guitar"]);
  });

  it("arrow keys move through suggestions and Enter picks the highlighted one", async () => {
    const { onChange, input } = renderInput([]);
    fireEvent.change(input, { target: { value: "i" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["Guitar"]);
  });
});
