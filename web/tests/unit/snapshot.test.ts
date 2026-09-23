import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSnapshot, gunzip, loadSnapshot } from "@/lib/snapshot";

const GZ = new Uint8Array(readFileSync(new URL("../fixtures/snapshot-leo.bin.gz", import.meta.url)));

describe("snapshot", () => {
  it("decodes the header and records written by the Python packer", async () => {
    const { header, records } = await loadSnapshot(GZ);
    expect(header.version).toBe(1);
    expect(header.count).toBe(2);
    expect(header.record_size).toBe(88);
    expect(header.owners).toEqual(["ISS", "PRC"]);
    expect(records[0]).toMatchObject({ noradId: 25544, owner: "ISS", type: "PAY" });
    expect(records[0].meanMotion).toBeCloseTo(15.49224498, 8);
    expect(records[0].epochMs).toBe(Date.UTC(2026, 8, 22, 6, 30, 37, 496) + 0.448);
    expect(records[1]).toMatchObject({ noradId: 29733, owner: "PRC", type: "DEB" });
    expect(records[1].inclination).toBeCloseTo(99.21, 10);
  });

  it("rejects data without the LEO1 magic", async () => {
    const raw = await gunzip(GZ);
    const broken = raw.slice();
    broken[0] = 0x58;
    expect(() => decodeSnapshot(broken)).toThrow(/LEO1/);
  });

  it("rejects truncated data", async () => {
    const raw = await gunzip(GZ);
    expect(() => decodeSnapshot(raw.slice(0, raw.length - 10))).toThrow(/truncated/);
  });
});
