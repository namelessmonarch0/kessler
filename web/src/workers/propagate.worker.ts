import type { SatRec } from "satellite.js";
import { propagateAll, recordToSatrec } from "@/lib/orbit";
import type { OrbitRecord } from "@/lib/snapshot";

export type WorkerIn = { kind: "load"; records: OrbitRecord[] } | { kind: "tick"; timeMs: number; id: number };
export type WorkerOut =
  | { kind: "loaded"; count: number; valid: number }
  | { kind: "positions"; id: number; timeMs: number; positions: Float32Array };

export function createHandler(post: (msg: WorkerOut, transfer?: Transferable[]) => void) {
  let satrecs: (SatRec | null)[] | null = null;
  return (msg: WorkerIn) => {
    if (msg.kind === "load") {
      satrecs = msg.records.map(recordToSatrec);
      post({ kind: "loaded", count: satrecs.length, valid: satrecs.filter(Boolean).length });
      return;
    }
    if (!satrecs) return;
    const positions = new Float32Array(satrecs.length * 3);
    propagateAll(satrecs, new Date(msg.timeMs), positions);
    post({ kind: "positions", id: msg.id, timeMs: msg.timeMs, positions }, [positions.buffer]);
  };
}

// Only wire up the message loop when running inside a worker (not when imported by tests).
// The minimal cast avoids pulling the "webworker" lib, whose globals clash with "dom".
type WorkerScope = {
  postMessage(msg: WorkerOut, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};
declare const WorkerGlobalScope: (new () => unknown) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const scope = self as unknown as WorkerScope;
  const handle = createHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));
  scope.onmessage = (e) => handle(e.data);
}
