import { describe, expect, it } from "vitest";
import { formatMonth, parseRefs, scoreTone, shiftQuarter, splitRefs } from "../okr";

describe("okr helpers", () => {
  it("formats months", () => {
    expect(formatMonth("2026-10")).toBe("Oct 2026");
    expect(formatMonth("bad")).toBe("bad");
  });

  it("shifts quarters across year boundaries", () => {
    expect(shiftQuarter("2026Q4", 1)).toBe("2027Q1");
    expect(shiftQuarter("2026Q1", -1)).toBe("2025Q4");
    expect(shiftQuarter("2026Q2", 0)).toBe("2026Q2");
  });

  it("tones scores around the 0.7 target", () => {
    expect(scoreTone(null)).toContain("placeholder");
    expect(scoreTone(0.7)).toContain("success");
    expect(scoreTone(0.5)).toContain("warning");
    expect(scoreTone(0.1)).toContain("danger");
  });

  it("splits and resolves refs, looking up KEY-SEQ identifiers", async () => {
    expect(splitRefs(" BOT-55, 3f2a91c0  T2DF-3 ")).toEqual(["BOT-55", "3f2a91c0", "T2DF-3"]);
    const ids = await parseRefs("bot-55, 3f2a91c0, BOT-55", async (key, seq) => ({ id: `${key}:${seq}` }));
    expect(ids).toEqual(["BOT:55", "3f2a91c0"]);
  });
});
