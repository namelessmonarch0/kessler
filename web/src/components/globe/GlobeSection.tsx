"use client";

import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { simClock } from "@/lib/clock";
import { loadSnapshot, type OrbitRecord } from "@/lib/snapshot";
import { useExplorer } from "@/lib/store";
import { subsolarPoint } from "@/lib/sun";
import { GlobeScene } from "@/components/globe/GlobeScene";
import { hasWebGL } from "@/components/globe/webgl";

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
      // Shortened form for narrow screens (drops the date and "OVER" so it fits on one line
      // over the object cloud instead of wrapping/overlapping — see GlobeSection review notes).
      setShort(`${iso.slice(11, 16)} UTC · SUN ${lat} ${lon}`);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return (
    <p className="label [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]" aria-live="off">
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
  const wantHigh = useExplorer((s) => s.orbits.high);
  const timeScale = useExplorer((s) => s.timeScale);
  const setTimeScale = useExplorer((s) => s.setTimeScale);

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

  return (
    <section className="card relative h-[420px] overflow-hidden sm:h-[560px]" aria-label="Live globe of tracked objects">
      {webgl && (
        <Canvas
          style={{ position: "absolute", inset: 0 }}
          camera={{ position: [0.6, 0.9, 3.6], fov: 40, near: 0.005, far: 100 }}
          dpr={[1, 2]}
          gl={{ antialias: true }}
        >
          <color attach="background" args={["#000000"]} />
          <GlobeScene leo={leo} high={high} />
        </Canvas>
      )}
      <div className="pointer-events-none absolute left-4 top-3 right-4 flex flex-col gap-1">
        <Readout live={webgl === true} />
        {webgl === false && <p className="text-sm text-ink-2">This device can&apos;t show the 3D globe (WebGL is unavailable). Charts and search still work.</p>}
        {webgl && status === "loading" && <p className="label">Loading orbits…</p>}
        {webgl && status === "missing" && <p className="text-sm text-ink-2">Orbit data not available yet.</p>}
        {webgl && status === "error" && <p className="text-sm text-ink-2">Data unavailable. The Earth is shown without objects.</p>}
      </div>
      <div className="absolute bottom-3 left-4 flex gap-2">
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
    </section>
  );
}
