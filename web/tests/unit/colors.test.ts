import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHART_COLORS, GLOBE_COLORS } from "@/lib/types";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("colour set", () => {
  it("uses the approved globe and chart colours", () => {
    expect(GLOBE_COLORS).toEqual({ PAY: "#fff4d6", DEB: "#ff6a3d", "R/B": "#c4a8ff", UNK: "#bdbdbd" });
    expect(CHART_COLORS).toEqual({ PAY: "#b58f3c", DEB: "#d64a3f", "R/B": "#957be0", UNK: "#8f8e88" });
  });

  it("no source file uses the retired colours", () => {
    const offenders = walk(SRC).filter((f) => /#3987e5|#d95926|#199e70/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("nothing imports full-frame postprocessing", () => {
    const offenders = walk(SRC).filter((f) => /from "(@react-three\/)?postprocessing"/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
