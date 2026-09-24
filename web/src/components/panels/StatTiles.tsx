"use client";

import { useEffect, useRef } from "react";
import { countUp } from "@/lib/motion";
import { GLOBE_COLORS, type Meta, type ObjectType } from "@/lib/types";
import { PixelIcon, type PixelIconName } from "@/components/ui/PixelIcon";
import { Unavailable } from "@/components/ui/Unavailable";

const TILES: { type: ObjectType; label: string; sub: string; icon: PixelIconName; color: string }[] = [
  { type: "PAY", label: "Payloads", sub: "active and dead satellites", icon: "sat", color: GLOBE_COLORS.PAY },
  { type: "DEB", label: "Debris", sub: "tracked fragments ≥10 cm", icon: "deb", color: GLOBE_COLORS.DEB },
  { type: "R/B", label: "Rocket bodies", sub: "spent upper stages", icon: "rb", color: GLOBE_COLORS["R/B"] },
];

function Tile({ value, index, ...t }: (typeof TILES)[number] & { value: number | null; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // No real count to animate yet (meta hasn't loaded) — leave the "—" placeholder in place
    // rather than counting up from a fake 0.
    if (!ref.current || value === null) return;
    // countUp returns the animejs tween (or null on the reduced-motion instant path) so we can
    // cancel it here: if `value` changes (meta arrives late) or this effect re-runs (StrictMode
    // double-mount), a stale in-flight tween must not keep writing over the latest value.
    const anim = countUp(ref.current, value, 300 + index * 120);
    return () => {
      anim?.cancel();
    };
  }, [value, index]);
  return (
    <div className="card p-3 sm:p-4" data-testid={`tile-${t.type}`}>
      <div className="flex items-center gap-2 text-[13px] text-ink-2"><PixelIcon name={t.icon} color={t.color} />{t.label}</div>
      <div ref={ref} className="mt-2 font-mono text-[21px] tabular-nums text-ink sm:text-[28px]">{value === null ? "—" : "0"}</div>
      <div className="mt-1 text-[12px] text-ink-3">{t.sub}</div>
    </div>
  );
}

export function StatTiles({ meta, error }: { meta: Meta | null; error: boolean }) {
  if (error) return <div className="card p-4"><Unavailable what="object counts" /></div>;
  return (
    <div className="grid grid-cols-3 gap-3">
      {TILES.map((t, i) => (
        <Tile key={t.type} {...t} index={i} value={meta?.in_orbit[t.type]?.LEO ?? null} />
      ))}
    </div>
  );
}
