"use client";

import { useEffect, useRef } from "react";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import type { WorkerIn, WorkerOut } from "@/workers/propagate.worker";

export type PropagationFrames = {
  current: { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };
};

const TICK_MS = 100;

/** Keeps the latest two position frames from the worker. Renderers interpolate between them
 * at simClock.now(). */
export function usePropagation(records: OrbitRecord[] | null): PropagationFrames {
  const frames = useRef({ prev: null as Float32Array | null, next: null as Float32Array | null, prevTime: 0, nextTime: 0 });

  useEffect(() => {
    if (!records || records.length === 0) return;
    const worker = new Worker(new URL("../../workers/propagate.worker.ts", import.meta.url), { type: "module" });
    let id = 0;
    let waiting = false;
    const request = () => {
      if (waiting) return;
      waiting = true;
      const msg: WorkerIn = { kind: "tick", timeMs: simClock.now() + TICK_MS * simClock.scale, id: ++id };
      worker.postMessage(msg);
    };
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.kind === "loaded") {
        request();
        return;
      }
      const f = frames.current;
      f.prev = f.next ?? msg.positions;
      f.prevTime = f.next ? f.nextTime : msg.timeMs;
      f.next = msg.positions;
      f.nextTime = msg.timeMs;
      waiting = false;
    };
    const load: WorkerIn = { kind: "load", records };
    worker.postMessage(load);
    const timer = window.setInterval(request, TICK_MS);
    return () => {
      window.clearInterval(timer);
      worker.terminate();
      frames.current = { prev: null, next: null, prevTime: 0, nextTime: 0 };
    };
  }, [records]);

  return frames;
}
