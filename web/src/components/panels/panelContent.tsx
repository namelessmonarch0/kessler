"use client";

import { chartTitle } from "@/lib/chartData";
import type { PanelId } from "@/lib/panels";
import type { BreakdownResponse, Meta, TimeseriesResponse } from "@/lib/types";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { ChatPanel } from "@/components/panels/ChatPanel";
import { Filters } from "@/components/panels/Filters";
import { ObjectCard } from "@/components/panels/ObjectCard";
import { Overview } from "@/components/panels/Overview";
import { SearchBox } from "@/components/panels/SearchBox";
import { Unavailable } from "@/components/ui/Unavailable";

export type Load<T> = { data: T | null; error: boolean };
export type PanelCtx = { meta: Load<Meta>; ts: Load<TimeseriesResponse>; bars: Load<BreakdownResponse> };

export const PANEL_CONTENT: Record<PanelId, (c: PanelCtx) => React.ReactNode> = {
  overview: (c) => <Overview meta={c.meta.data} error={c.meta.error} />,
  search: () => (
    <div className="flex flex-col gap-3">
      <SearchBox />
      <ObjectCard />
    </div>
  ),
  history: (c) => (
    <div>
      <h3 className="font-mono text-[16px] text-ink">{c.ts.data ? chartTitle(c.ts.data) : "Objects in orbit by type"}</h3>
      <p className="mt-1 text-[13px] leading-snug text-ink-2">Objects in orbit at the end of each year.</p>
      <div className="mt-2">{c.ts.error ? <Unavailable what="yearly history" /> : c.ts.data && <LineChart data={c.ts.data} />}</div>
    </div>
  ),
  owners: (c) => (
    <div>
      <h3 className="font-mono text-[16px] text-ink">Who owns what&apos;s up there</h3>
      <div className="mt-2">{c.bars.error ? <Unavailable what="owners" /> : c.bars.data && <BarChart data={c.bars.data} owners={c.meta.data?.owners ?? []} />}</div>
    </div>
  ),
  filters: (c) => <Filters meta={c.meta.data} />,
  chat: () => <ChatPanel />,
};
