"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtDate, fmtKm } from "@/lib/format";
import { useExplorer } from "@/lib/store";
import { TYPE_LABELS, type ObjectDetail } from "@/lib/types";
import { Unavailable } from "@/components/ui/Unavailable";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-[#1c1c1c] py-1.5 text-[13px]">
      <dt className="text-ink-2">{k}</dt>
      <dd className="text-right font-mono text-ink">{v}</dd>
    </div>
  );
}

export function ObjectCard() {
  const selectedId = useExplorer((s) => s.selectedId);
  const select = useExplorer((s) => s.select);
  const [obj, setObj] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    // Reset the previous object's details before fetching the newly selected one, so the card
    // doesn't briefly show stale data for the wrong id. This mirrors an external fetch keyed by
    // `selectedId`, which react-hooks/set-state-in-effect doesn't distinguish from an avoidable
    // derived-state effect — see the identical justification on GlobeSection's WebGL probe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setObj(null);
    setError(false);
    api.object(selectedId).then((o) => !cancelled && setObj(o)).catch(() => !cancelled && setError(true));
    return () => { cancelled = true; };
  }, [selectedId]);

  if (selectedId === null) return null;
  return (
    <div data-testid="object-card">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-mono text-[18px] text-ink">{obj?.name ?? `NORAD ${selectedId}`}</h2>
        <button type="button" onClick={() => select(null)} className="text-sm text-ink-2 hover:text-ink" aria-label="Close">✕</button>
      </div>
      {error && <Unavailable what="object details" />}
      {obj && (
        <dl className="mt-3">
          <Row k="Type" v={TYPE_LABELS[obj.object_type]} />
          <Row k="Owner" v={`${obj.flag_emoji ?? ""} ${obj.owner_name}`.trim()} />
          <Row k="Status" v={obj.ops_status_label ?? "Unknown"} />
          <Row k="Launched" v={`${fmtDate(obj.launch_date)}${obj.launch_site_name ? ` · ${obj.launch_site_name}` : ""}`} />
          <Row k="Orbit" v={`${fmtKm(obj.perigee)} × ${fmtKm(obj.apogee)}`} />
          <Row k="Inclination" v={obj.inclination === null ? "—" : `${obj.inclination.toFixed(1)}°`} />
          <Row k="Catalog no." v={`${obj.norad_id} · ${obj.cospar_id ?? "—"}`} />
          {obj.event && <Row k="Created by" v={`${obj.event.name} (${obj.event.event_date.slice(0, 4)})`} />}
          {obj.decay_date && <Row k="Re-entered" v={fmtDate(obj.decay_date)} />}
        </dl>
      )}
    </div>
  );
}
