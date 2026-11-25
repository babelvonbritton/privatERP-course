import { describe, expect, it } from "vitest";
import { allSkills, courseRequiredSkills, dedupeSkills, isTrainerQualified, rankTrainersForCourse, trainerSkillMatchCount } from "@/lib/domain/types";

const trainer = (name: string, subjects: string[]) => ({ name, subjects });

describe("skill helpers", () => {
  it("dedupes skills case-insensitively, keeping the first-seen casing and order", () => {
    expect(dedupeSkills(["Piano", " piano ", "Guitar", "GUITAR", "", "  "])).toEqual(["Piano", "Guitar"]);
  });

  it("collects every skill already used, from trainer subjects and course required skills", () => {
    expect(allSkills([trainer("Budi", ["Piano"]), trainer("Siti", ["guitar"])], [{ requiredSkills: ["Piano", "Violin"] }])).toEqual([
      "Piano",
      "guitar",
      "Violin",
    ]);
  });

  it("reads required skills from a course, tolerating a row written before they existed", () => {
    expect(courseRequiredSkills({ requiredSkills: ["Piano", "piano"] })).toEqual(["Piano"]);
    expect(courseRequiredSkills({})).toEqual([]);
    expect(courseRequiredSkills({ requiredSkills: "Piano" })).toEqual([]);
  });

  it("counts matching required skills case-insensitively", () => {
    expect(trainerSkillMatchCount(trainer("Budi", ["Piano", "Guitar"]), ["piano", "Violin"])).toBe(1);
    expect(trainerSkillMatchCount(trainer("Budi", ["Piano"]), ["Piano", "piano"])).toBe(1);
  });
});

describe("rankTrainersForCourse", () => {
  const trainers = [
    trainer("Budi", ["Piano"]),
    trainer("Siti", ["Piano", "Guitar", "Violin"]),
    trainer("Dewi", ["Guitar"]),
    trainer("Andi", ["Drums"]),
  ];

  it("ranks more matches on top, ties alphabetical, and excludes zero-match trainers", () => {
    const ranked = rankTrainersForCourse(trainers, ["Piano", "Guitar"]);
    expect(ranked.map((r) => [r.trainer.name, r.matches])).toEqual([
      ["Siti", 2],
      ["Budi", 1],
      ["Dewi", 1],
    ]);
  });

  it("with no required skills every trainer is choosable in the given order", () => {
    const ranked = rankTrainersForCourse(trainers, []);
    expect(ranked.map((r) => r.trainer.name)).toEqual(["Budi", "Siti", "Dewi", "Andi"]);
    expect(ranked.every((r) => r.matches === 0)).toBe(true);
  });

  it("returns no one when no trainer matches", () => {
    expect(rankTrainersForCourse(trainers, ["Cello"])).toEqual([]);
  });

  it("qualification is at-least-one: one shared skill is enough", () => {
    expect(isTrainerQualified(trainer("Budi", ["Piano"]), ["Piano", "Guitar"])).toBe(true);
    expect(isTrainerQualified(trainer("Andi", ["Drums"]), ["Piano", "Guitar"])).toBe(false);
    expect(isTrainerQualified(trainer("Andi", ["Drums"]), [])).toBe(true);
  });
});
