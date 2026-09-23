import { describe, expect, it } from "vitest";
import { lonLatToTexel, ringSegments } from "@/components/globe/earthTexture";
import { hasWebGL } from "@/components/globe/webgl";

describe("lonLatToTexel", () => {
  it("maps the equirectangular corners and centre", () => {
    expect(lonLatToTexel(-180, 90, 400, 200)).toEqual([0, 0]);
    expect(lonLatToTexel(0, 0, 400, 200)).toEqual([200, 100]);
    expect(lonLatToTexel(180, -90, 400, 200)).toEqual([400, 200]);
  });
});

describe("ringSegments", () => {
  it("splits rings that jump across the antimeridian", () => {
    const segs = ringSegments([[170, 0], [179, 1], [-179, 1], [-170, 0]], 360, 180);
    expect(segs.length).toBe(2);
    expect(segs[0].length).toBe(2);
    expect(segs[1].length).toBe(2);
  });
  it("keeps a normal ring as one segment", () => {
    expect(ringSegments([[0, 0], [10, 0], [10, 10]], 360, 180).length).toBe(1);
  });
});

describe("hasWebGL", () => {
  it("hasWebGL returns false when no context is available", () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(doc)).toBe(false);
  });
  it("returns false when canvas creation throws, true when a context exists", () => {
    const throwing = { createElement: () => { throw new Error("no canvas"); } } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(throwing)).toBe(false);
    const ok = { createElement: () => ({ getContext: (k: string) => (k === "webgl2" ? {} : null) }) } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(ok)).toBe(true);
  });
  it("returns false when only a WebGL1 context is available (three 0.186 requires WebGL2)", () => {
    const webgl1Only = {
      createElement: () => ({ getContext: (k: string) => (k === "webgl" ? {} : null) }),
    } as unknown as Pick<Document, "createElement">;
    expect(hasWebGL(webgl1Only)).toBe(false);
  });
});
