// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TrainerPicker } from "@/components/ui/TrainerPicker";
import { rankTrainersForCourse, type Trainer } from "@/lib/domain/types";
import { Providers } from "./support";

const trainer = (id: string, name: string, subjects: string[]) =>
  ({ id, name, subjects, email: "", phone: "", ratePerSession: 0, status: "active" }) as unknown as Trainer;

describe("TrainerPicker", () => {
  afterEach(() => cleanup());

  it("lists qualified trainers ranked by match count, with the count on each row", () => {
    const ranked = rankTrainersForCourse(
      [trainer("b", "Budi", ["Piano"]), trainer("s", "Siti", ["Piano", "Guitar"]), trainer("d", "Dewi", ["Drums"])],
      ["Piano", "Guitar"],
    );
    const onChange = vi.fn();
    render(
      <Providers>
        <TrainerPicker
          name="trainer"
          trainers={ranked}
          requiredSkills={["Piano", "Guitar"]}
          value=""
          onChange={onChange}
          label="Trainer"
          emptyMessage="No trainer teaches any of the skills this course requires."
        />
      </Providers>,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["s", "b"]);
    expect(screen.getByRole("radio", { name: /Siti/ }).closest("label")?.textContent).toContain("Matches 2 of 2 required skills");
    expect(screen.getByRole("radio", { name: /Budi/ }).closest("label")?.textContent).toContain("Matches 1 of 2 required skills");
    expect(screen.queryByRole("radio", { name: /Dewi/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Siti/ }));
    expect(onChange).toHaveBeenCalledWith("s");
  });

  it("says plainly when no trainer qualifies", () => {
    render(
      <Providers>
        <TrainerPicker
          name="trainer"
          trainers={[]}
          requiredSkills={["Cello"]}
          value=""
          onChange={vi.fn()}
          label="Trainer"
          emptyMessage="No trainer teaches any of the skills this course requires."
        />
      </Providers>,
    );
    expect(screen.getByRole("status").textContent).toContain("No trainer teaches any of the skills this course requires.");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("shows the hint instead of the list until a course is chosen", () => {
    render(
      <Providers>
        <TrainerPicker
          name="trainer"
          trainers={[]}
          requiredSkills={[]}
          value=""
          onChange={vi.fn()}
          label="Trainer"
          disabled
          disabledHint="Choose a course first to see which trainers qualify."
        />
      </Providers>,
    );
    expect(screen.getByText("Choose a course first to see which trainers qualify.")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
