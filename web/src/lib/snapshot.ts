import type { ObjectType } from "@/lib/types";

export interface SnapshotHeader {
  version: number;
  generated_at: string;
  count: number;
  owners: string[];
  types: ObjectType[];
  record_size: number;
  fields: string[];
}

export interface OrbitRecord {
  noradId: number;
  owner: string;
  type: ObjectType;
  epochMs: number;
  meanMotion: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  argPericenter: number;
  meanAnomaly: number;
  bstar: number;
  meanMotionDot: number;
  meanMotionDdot: number;
}

const MAGIC = "LEO1";
const RECORD_SIZE = 88;

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes uncompressed LEO1 bytes (see api/app/ingest/snapshot.py). Records are not 8-byte
 * aligned after the JSON header, so they are read with a DataView, not typed-array views. */
export function decodeSnapshot(raw: Uint8Array): { header: SnapshotHeader; records: OrbitRecord[] } {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.byteLength < 8 || new TextDecoder().decode(raw.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a LEO1 snapshot");
  }
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLen))) as SnapshotHeader;
  if (header.record_size !== RECORD_SIZE) throw new Error(`unsupported record size ${header.record_size}`);
  const start = 8 + headerLen;
  if (raw.byteLength < start + header.count * RECORD_SIZE) throw new Error("snapshot is truncated");

  const records: OrbitRecord[] = new Array(header.count);
  for (let i = 0; i < header.count; i++) {
    const o = start + i * RECORD_SIZE;
    const f = (k: number) => view.getFloat64(o + 8 + k * 8, true);
    records[i] = {
      noradId: view.getUint32(o, true),
      owner: header.owners[view.getUint16(o + 4, true)],
      type: header.types[view.getUint8(o + 6)],
      epochMs: f(0) * 1000,
      meanMotion: f(1),
      eccentricity: f(2),
      inclination: f(3),
      raan: f(4),
      argPericenter: f(5),
      meanAnomaly: f(6),
      bstar: f(7),
      meanMotionDot: f(8),
      meanMotionDdot: f(9),
    };
  }
  return { header, records };
}

export async function loadSnapshot(gz: Uint8Array) {
  return decodeSnapshot(await gunzip(gz));
}
