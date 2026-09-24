"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PANELS, type PanelId } from "@/lib/panels";
import { regimesFor, useExplorer } from "@/lib/store";
import { useSheetLayout } from "@/lib/useIsMobile";
import type { BreakdownResponse, Meta, TimeseriesResponse } from "@/lib/types";
import { MobileSheet } from "@/components/layout/MobileSheet";
import { Panel } from "@/components/layout/Panel";
import { PanelColumn } from "@/components/layout/PanelColumn";
import { PanelDock } from "@/components/layout/PanelDock";
import { PANEL_CONTENT, type Load, type PanelCtx } from "@/components/panels/panelContent";

// GlobeSection pulls in three/R3F/satellite.js — by far the largest slice of the
// page's JS — and only ever renders client-side anyway (it probes WebGL support in an effect and
// has no server-renderable content). Loading it with next/dynamic(ssr:false) keeps that whole
// graph out of the page's initial bundle so tiles/search/charts can hydrate without parsing it
// first; the loading placeholder matches GlobeSection's own outer <section> exactly (same
// classes/aria-label) so swapping it in doesn't shift layout.
const GlobeSection = dynamic(() => import("@/components/globe/GlobeSection").then((m) => m.GlobeSection), {
  ssr: false,
  loading: () => <section className="fixed inset-0" aria-label="Live globe of tracked objects" />,
});

export default function Explorer() {
  const [meta, setMeta] = useState<Load<Meta>>({ data: null, error: false });
  const [ts, setTs] = useState<Load<TimeseriesResponse>>({ data: null, error: false });
  const [bars, setBars] = useState<Load<BreakdownResponse>>({ data: null, error: false });
  const owners = useExplorer((s) => s.owners);
  const types = useExplorer((s) => s.types);
  const orbits = useExplorer((s) => s.orbits);
  const hydratePanels = useExplorer((s) => s.hydratePanels);
  // null until hydrated: the server HTML (and the hydration pass) renders both layout shells and
  // CSS (`sheet:` / `wide:` variants) shows the right one, so first paint never flashes the wrong
  // layout. Panel bodies are rendered in only ONE shell at a time — the desktop columns before
  // hydration (the sheet shows just its tab bar until then), then whichever layout matches — so
  // there's never a second SearchBox (or any other duplicated panel) in the DOM.
  const sheet = useSheetLayout();

  useEffect(() => hydratePanels(), [hydratePanels]);

  useEffect(() => {
    api.meta().then((d) => setMeta({ data: d, error: false })).catch(() => setMeta({ data: null, error: true }));
  }, []);

  useEffect(() => {
    // Filters can change faster than the network responds (e.g. clicking two filter chips in a
    // row); without this guard, an earlier request's response arriving after a later one would
    // stomp the chart with stale data for the wrong filters.
    let cancelled = false;
    const regimes = regimesFor(orbits);
    api.timeseries({ group_by: "type", owners, types, regimes, from: 1960 })
      .then((d) => !cancelled && setTs({ data: d, error: false }))
      .catch(() => !cancelled && setTs({ data: null, error: true }));
    api.breakdown({ by: "owner", types, regimes, top: 5 })
      .then((d) => !cancelled && setBars({ data: d, error: false }))
      .catch(() => !cancelled && setBars({ data: null, error: true }));
    return () => {
      cancelled = true;
    };
  }, [owners, types, orbits]);

  const ctx: PanelCtx = { meta, ts, bars };
  const panel = (id: PanelId, extra = "") => (
    <Panel id={id} title={PANELS.find((p) => p.id === id)!.title} className={extra}>{PANEL_CONTENT[id](ctx)}</Panel>
  );
  return (
    <main className="h-dvh overflow-hidden">
      <GlobeSection />
      {sheet !== false && <MobileSheet ctx={ctx} showBody={sheet === true} />}
      {sheet !== true && (
        <div className="sheet:hidden">
          <div className="pointer-events-none fixed inset-x-0 top-3 z-20 flex justify-center px-[calc(theme(spacing.4)+var(--col-l))]">
            <PanelDock />
          </div>
          <PanelColumn side="left" className="pointer-events-none fixed bottom-4 left-4 top-14 z-10 flex w-[var(--col-l)] flex-col justify-between gap-3 overflow-y-auto">
            <div className="flex flex-col gap-3">{panel("overview")}{panel("filters")}</div>
            {panel("history")}
          </PanelColumn>
          <PanelColumn side="right" className="pointer-events-none fixed bottom-4 right-4 top-14 z-10 flex w-[var(--col-r)] flex-col justify-between gap-3 overflow-y-auto">
            <div className="flex flex-col gap-3">{panel("search")}{panel("chat")}</div>
            {panel("owners")}
          </PanelColumn>
        </div>
      )}
    </main>
  );
}
