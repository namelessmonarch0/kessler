import { readFileSync } from "node:fs";
import { eciToEcf, gstime, propagate, sgp4, twoline2satrec } from "satellite.js";
import { describe, expect, it } from "vitest";
import { ecefToGeodetic, greatCircleKm, sceneToEcef } from "@/lib/geo";
import { ecefToScene, recordToSatrec } from "@/lib/orbit";
import { decodeSnapshot, gunzip, type OrbitRecord } from "@/lib/snapshot";

const fx = (n: string) => readFileSync(new URL(`../fixtures/accuracy/${n}`, import.meta.url));
type Sample = { timeMs: number; ecefKm: [number, number, number]; latDeg: number; lonDeg: number; altKm: number };
const golden = JSON.parse(fx("golden.json").toString()) as { objects: { label: string; record: OrbitRecord; samples: Sample[] }[] };
const vectors = JSON.parse(fx("sgp4-vectors.json").toString()) as { cases: { satnum: string; line1: string; line2: string; samples: { tsinceMin: number; temeKm: [number, number, number] }[] }[] };

/** The site's pipeline, end to end, for one record at one time: returns ECEF km via the scene frame. */
function sitePosition(rec: OrbitRecord, timeMs: number): [number, number, number] | null {
  const satrec = recordToSatrec(rec);
  if (!satrec) return null;
  const date = new Date(timeMs);
  const pv = propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const ecf = eciToEcf(pv.position, gstime(date));
  const scene = new Float32Array(3);
  ecefToScene(ecf.x, ecf.y, ecf.z, scene, 0);
  return sceneToEcef(scene[0], scene[1], scene[2]);
}

describe("T2 snapshot decode", () => {
  it("decodes the API-packed snapshot to the exact source elements", async () => {
    const expected = JSON.parse(fx("api-snapshot.elements.json").toString()) as OrbitRecord[];
    const { records } = decodeSnapshot(await gunzip(new Uint8Array(fx("api-snapshot.bin.gz"))));
    expect(records).toEqual(expected);
  });
});

describe("T3/T4 site pipeline vs skyfield (independent)", () => {
  for (const obj of golden.objects) {
    for (const s of obj.samples) {
      it(`${obj.label} at ${new Date(s.timeMs).toISOString()}`, () => {
        const p = sitePosition(obj.record, s.timeMs);
        expect(p, "propagation failed").not.toBeNull();
        const g = ecefToGeodetic(...p!);
        const ground = greatCircleKm(g.latDeg, g.lonDeg, s.latDeg, s.lonDeg);
        expect(ground, "ground distance km").toBeLessThanOrEqual(1);
        expect(Math.abs(g.altKm - s.altKm), "altitude km").toBeLessThanOrEqual(1);
        expect(Math.abs(g.latDeg - s.latDeg), "latitude deg").toBeLessThanOrEqual(0.01);
        const dLon = ((g.lonDeg - s.lonDeg + 540) % 360) - 180;
        expect(Math.abs(dLon), "longitude deg").toBeLessThanOrEqual(0.01);
        if (obj.label !== "GEO") {
          const d3 = Math.hypot(p![0] - s.ecefKm[0], p![1] - s.ecefKm[1], p![2] - s.ecefKm[2]);
          expect(d3, "3D km (LEO)").toBeLessThanOrEqual(1);
        }
      });
    }
  }
});

describe("T5 official SGP4 verification vectors", () => {
  for (const c of vectors.cases) {
    it(`satnum ${c.satnum}`, () => {
      const rec = twoline2satrec(c.line1, c.line2);
      for (const s of c.samples) {
        const pv = sgp4(rec, s.tsinceMin); // minutes since the element epoch
        expect(pv && pv.position, `t=${s.tsinceMin}`).toBeTruthy();
        const p = pv!.position as { x: number; y: number; z: number };
        expect(Math.abs(p.x - s.temeKm[0])).toBeLessThanOrEqual(0.001);
        expect(Math.abs(p.y - s.temeKm[1])).toBeLessThanOrEqual(0.001);
        expect(Math.abs(p.z - s.temeKm[2])).toBeLessThanOrEqual(0.001);
      }
    });
  }
});
