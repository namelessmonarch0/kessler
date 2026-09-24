"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { simClock } from "@/lib/clock";
import { loadSnapshot, type OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { subsolarPoint } from "@/lib/sun";
import { GlobeErrorBoundary } from "@/components/globe/GlobeErrorBoundary";
import { GlobeScene } from "@/components/globe/GlobeScene";
import { hasWebGL } from "@/components/globe/webgl";

const NO_WEBGL_MESSAGE = "This device can't show the 3D globe (WebGL is unavailable). Charts and search still work.";

type Status = "loading" | "ready" | "missing" | "error";

async function fetchGroup(group: "LEO" | "HIGH"): Promise<OrbitRecord[] | null> {
  const gz = await api.snapshot(group);
  return gz ? (await loadSnapshot(gz)).records : null;
}

// `live` is true once the <Canvas> is mounted and ticking simClock every frame. Without it (no
// WebGL, or the probe hasn't resolved yet) nothing ever advances simClock.t past its initial
// mount value, so the readout would otherwise freeze at page-load time forever; read the real
// wall clock directly in that case instead.
function Readout({ live }: { live: boolean }) {
  const [full, setFull] = useState("");
  const [short, setShort] = useState("");
  useEffect(() => {
    const update = () => {
      const d = new Date(live ? simClock.now() : Date.now());
      const s = subsolarPoint(d);
      const lat = `${Math.abs(s.latDeg).toFixed(1)}°${s.latDeg >= 0 ? "N" : "S"}`;
      const lon = `${Math.abs(s.lonDeg).toFixed(1)}°${s.lonDeg >= 0 ? "E" : "W"}`;
      const iso = d.toISOString();
      setFull(`${iso.slice(0, 16).replace("T", " ")} UTC · SUN OVER ${lat} ${lon}`);
      // Shortened form for phone widths, shown in the top bar (see GlobeSection): drops the date,
      // "OVER", and the decimal degree so the whole thing stays on one line at 390px instead of
      // wrapping onto a second line and eating into the globe's headroom.
      const latShort = `${Math.round(Math.abs(s.latDeg))}°${s.latDeg >= 0 ? "N" : "S"}`;
      const lonShort = `${Math.round(Math.abs(s.lonDeg))}°${s.lonDeg >= 0 ? "E" : "W"}`;
      setShort(`${iso.slice(11, 16)} UTC · ${latShort} ${lonShort}`);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return (
    <p className="label text-center [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" aria-live="off">
      <span className="hidden sm:inline">{full}</span>
      <span className="sm:hidden">{short}</span>
    </p>
  );
}

export function GlobeSection() {
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [leo, setLeo] = useState<OrbitRecord[] | null>(null);
  const [high, setHigh] = useState<OrbitRecord[] | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [renderFailed, setRenderFailed] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  // Whether the globe card is scrolled into view *and* the tab is foregrounded. Drives both the
  // R3F render loop (frameloop="never" while inactive) and the propagation worker's tick
  // interval (paused via the `active` prop threaded down to usePropagation), so an offscreen or
  // backgrounded globe stops burning CPU/battery on rendering and orbit propagation it isn't
  // showing anyone.
  const [active, setActive] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const wantHigh = useExplorer((s) => s.orbits.high);
  const timeScale = useExplorer((s) => s.timeScale);
  const setTimeScale = useExplorer((s) => s.setTimeScale);
  // True once WebGL is unavailable for any reason: no support at all, the R3F render tree threw
  // (caught by GlobeErrorBoundary), or the GPU context was lost after the canvas mounted. All
  // three show the same fallback message in place of the globe.
  const broken = webgl === false || renderFailed || contextLost;

  // WebGL support can only be probed client-side (needs `document`); deferring to an effect
  // (instead of a lazy useState initializer) keeps the SSR/hydration pass identical, at the cost
  // of tripping eslint-plugin-react-hooks's new set-state-in-effect rule for this one-shot check.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setWebgl(hasWebGL()), []);

  useEffect(() => {
    let cancelled = false;
    fetchGroup("LEO")
      .then((records) => {
        if (cancelled) return;
        setLeo(records);
        setStatus(records ? "ready" : "missing");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!wantHigh || high) return;
    fetchGroup("HIGH").then(setHigh).catch(() => undefined);
  }, [wantHigh, high]);

  // webglcontextlost is a native browser event (GPU reset, driver crash, too many contexts),
  // not a thrown error, so GlobeErrorBoundary can't see it — listen on the canvas directly and
  // fall back to the same no-WebGL message instead of leaving a blank/frozen card.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!webgl || !canvas) return;
    const onLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [webgl]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    let intersecting = true;
    const update = () => setActive(intersecting && document.visibilityState === "visible");
    const io = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <section ref={sectionRef} className="fixed inset-0" aria-label="Live globe of tracked objects">
      {webgl && !broken && (
        <GlobeErrorBoundary onError={() => setRenderFailed(true)}>
          <Canvas
            ref={canvasRef}
            frameloop={active ? "always" : "never"}
            style={{ position: "absolute", inset: 0 }}
            camera={{ position: [0.6, 0.9, 3.6], fov: 40, near: 0.005, far: 100 }}
            dpr={[1, 2]}
            gl={{ antialias: true }}
          >
            <color attach="background" args={["#000000"]} />
            <GlobeScene leo={leo} high={high} active={active} labelsRef={labelsRef} />
          </Canvas>
        </GlobeErrorBoundary>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-1 text-center">
        {broken && <p className="text-sm text-ink-2">{NO_WEBGL_MESSAGE}</p>}
        {webgl && !broken && status === "loading" && <p className="label">Loading orbits…</p>}
        {webgl && !broken && status === "missing" && <p className="text-sm text-ink-2">Orbit data not available yet.</p>}
        {webgl && !broken && status === "error" && <p className="text-sm text-ink-2">Data unavailable. The Earth is shown without objects.</p>}
      </div>
      {/* On phone widths (<640px) the panel sheet docks at the bottom of the screen (see
          MobileSheet) and can cover roughly the lower half of it, so these controls move to a top
          bar there instead of sitting at the usual bottom-4 (which the sheet would cover, or come
          close to). At >=640px (tablet/desktop, no sheet) this is unchanged from before Task 5. */}
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-2 sm:top-auto sm:bottom-4">
        <Readout live={webgl === true && !broken} />
        <div className="flex gap-2">
          {([1, 4320] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                if (s === 1) simClock.reset();
                setTimeScale(s);
              }}
              aria-pressed={timeScale === s}
              className={`rounded-full border-2 px-3 py-2 text-sm ${timeScale === s ? "border-ink text-ink" : "border-line text-ink-2"} bg-[#121212]`}
            >
              {s === 1 ? "Live" : "Fast · 1 day / 20 s"}
            </button>
          ))}
        </div>
      </div>
      <div ref={labelsRef} data-testid="globe-labels" aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" />
    </section>
  );
}
