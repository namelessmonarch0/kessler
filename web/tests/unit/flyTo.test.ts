import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { findPosition, shortestAngle } from "@/components/globe/flyTo";

describe("shortestAngle", () => {
  it("goes the short way round the globe", () => {
    expect(shortestAngle(0.1, 0.3)).toBeCloseTo(0.2, 10);
    expect(shortestAngle(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 10);
    expect(shortestAngle(-3.0, 3.0)).toBeCloseTo(-(2 * Math.PI - 6), 10);
  });
});

describe("findPosition", () => {
  it("skips holes in a sparse locator list (e.g. a group whose snapshot hasn't loaded)", () => {
    const target = new THREE.Vector3(1, 2, 3);
    const locators = [undefined, (id: number) => (id === 42 ? target : null)];
    expect(findPosition(locators, 42)).toBe(target);
  });

  it("returns the first locator's non-null hit, skipping ones that miss", () => {
    const leo = new THREE.Vector3(1, 0, 0);
    const high = new THREE.Vector3(0, 1, 0);
    const locators = [
      (id: number) => (id === 1 ? leo : null),
      (id: number) => (id === 2 ? high : null),
    ];
    expect(findPosition(locators, 2)).toBe(high);
  });

  it("returns null when nothing matches, including all-holes", () => {
    expect(findPosition([undefined, undefined], 7)).toBeNull();
    expect(findPosition([(id: number) => (id === 1 ? new THREE.Vector3() : null)], 7)).toBeNull();
  });
});
