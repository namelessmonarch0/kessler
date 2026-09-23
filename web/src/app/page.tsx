"use client";

import { animate, stagger } from "animejs";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { chartTitle } from "@/lib/chartData";
import { prefersReducedMotion } from "@/lib/motion";
import { regimesFor, useExplorer } from "@/lib/store";
import type { BreakdownResponse, Meta, TimeseriesResponse } from "@/lib/types";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { GlobeSection } from "@/components/globe/GlobeSection";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { Filters } from "@/components/panels/Filters";
import { Footer } from "@/components/panels/Footer";
import { Header } from "@/components/panels/Header";
import { Intro } from "@/components/panels/Intro";
import { ObjectCard } from "@/components/panels/ObjectCard";
import { SearchBox } from "@/components/panels/SearchBox";
import { StatTiles } from "@/components/panels/StatTiles";
import { Card } from "@/components/ui/Card";
import { Unavailable } from "@/components/ui/Unavailable";

type Load<T> = { data: T | null; error: boolean };

export default function Explorer() {
  const [meta, setMeta] = useState<Load<Meta>>({ data: null, error: false });
  const [ts, setTs] = useState<Load<TimeseriesResponse>>({ data: null, error: false });
  const [bars, setBars] = useState<Load<BreakdownResponse>>({ data: null, error: false });
  const owners = useExplorer((s) => s.owners);
  const types = useExplorer((s) => s.types);
  const orbits = useExplorer((s) => s.orbits);

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

  // Stagger the intro cards in on load. Snapshot the `.card` elements present right now (rather
  // than handing animejs the live ".card" selector) so the fade-in only ever touches the cards
  // that exist at mount — e.g. the object card and the charts render later, once data or a
  // selection arrives, and must render at their normal opacity instead of inheriting an
  // animation that started (and could be interrupted) before they existed.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const cards = document.querySelectorAll<HTMLElement>(".card");
    if (!cards.length) return;
    animate(cards, { opacity: [0, 1], translateY: [18, 0], delay: stagger(70), duration: 700, ease: "outExpo" });
  }, []);

  return (
    <main className="mx-auto max-w-[1280px] px-4 pb-10 sm:px-7">
      <Header />
      <div id="explore" className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <GlobeSection />
        <div className="flex min-w-0 flex-col gap-5">
          <Intro />
          <StatTiles meta={meta.data} error={meta.error} />
          <ObjectCard />
          <Card><SearchBox /></Card>
        </div>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
        <Card aria-label="History chart" className="min-w-0 self-start">
          <h2 className="font-mono text-[18px] text-ink">{ts.data ? chartTitle(ts.data) : "Objects in orbit by type"}</h2>
          <p className="mt-1 text-[13px] leading-snug text-ink-2">
            Objects in orbit at the end of each year. Collisions and anti-satellite tests caused the debris jumps;
            Starlink-era launches drive the payload surge.
          </p>
          <div className="mt-3">{ts.error ? <Unavailable what="yearly history" /> : ts.data && <LineChart data={ts.data} />}</div>
        </Card>
        <div className="flex min-w-0 flex-col gap-5">
          <Card aria-label="Owners chart">
            <h2 className="font-mono text-[18px] text-ink">Who owns what&apos;s up there</h2>
            <p className="mt-1 text-[13px] text-ink-2">Objects in orbit today, by owner and type.</p>
            <div className="mt-3">{bars.error ? <Unavailable what="owners" /> : bars.data && <BarChart data={bars.data} owners={meta.data?.owners ?? []} />}</div>
          </Card>
          <Filters meta={meta.data} />
          <ChatPanel />
        </div>
      </div>
      <Footer meta={meta.data} />
    </main>
  );
}
