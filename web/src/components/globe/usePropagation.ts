"use client";

import { useCallback, useEffect, useRef } from "react";
import { simClock } from "@/lib/clock";
import type { OrbitRecord } from "@/lib/snapshot";
import type { WorkerIn, WorkerOut } from "@/workers/propagate.worker";

export type PropagationFrames = {
  current: { prev: Float32Array | null; next: Float32Array | null; prevTime: number; nextTime: number };
};

const TICK_MS = 100;

/** Asks the worker for an object's orbit path (see WorkerIn "path"); resolves null if the worker went away. */
export type RequestPath = (index: number, centerMs: number, steps: number) => Promise<Float32Array | null>;

/** Keeps the latest two position frames from the worker. Renderers interpolate between them
 * at simClock.now(). `active` (default true) pauses the tick interval — without tearing down
 * the worker or losing the last two frames — while the globe is offscreen or the tab is
 * backgrounded, so an invisible globe doesn't keep propagating orbits nobody is rendering. */
export function usePropagation(records: OrbitRecord[] | null, active = true): { frames: PropagationFrames; requestPath: RequestPath } {
  const frames = useRef({ prev: null as Float32Array | null, next: null as Float32Array | null, prevTime: 0, nextTime: 0 });
  const requestRef = useRef<() => void>(() => {});
  const pathRef = useRef<RequestPath>(async () => null);

  useEffect(() => {
    if (!records || records.length === 0) return;
    const worker = new Worker(new URL("../../workers/propagate.worker.ts", import.meta.url), { type: "module" });
    let id = 0;
    let waiting = false;
    const request = () => {
      if (waiting) return;
      waiting = true;
      const msg: WorkerIn = { kind: "tick", timeMs: simClock.now() + TICK_MS, id: ++id };
      worker.postMessage(msg);
    };
    requestRef.current = request;
    const pendingPaths = new Map<number, (p: Float32Array | null) => void>();
    let pathId = 0;
    pathRef.current = (index, centerMs, steps) =>
      new Promise((resolve) => {
        const pid = ++pathId;
        pendingPaths.set(pid, resolve);
        const msg: WorkerIn = { kind: "path", id: pid, index, centerMs, steps };
        worker.postMessage(msg);
      });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.kind === "loaded") {
        request();
        return;
      }
      if (msg.kind === "path") {
        pendingPaths.get(msg.id)?.(msg.positions);
        pendingPaths.delete(msg.id);
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
    return () => {
      requestRef.current = () => {};
      pathRef.current = async () => null;
      pendingPaths.forEach((resolve) => resolve(null));
      worker.terminate();
      frames.current = { prev: null, next: null, prevTime: 0, nextTime: 0 };
    };
  }, [records]);

  // Kept separate from the effect above so toggling `active` pauses/resumes the tick cadence
  // without restarting the worker (which would re-send every record and drop in-flight frames).
  useEffect(() => {
    if (!active || !records || records.length === 0) return;
    const timer = window.setInterval(() => requestRef.current(), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, records]);

  const requestPath = useCallback<RequestPath>((index, centerMs, steps) => pathRef.current(index, centerMs, steps), []);
  return { frames, requestPath };
}
