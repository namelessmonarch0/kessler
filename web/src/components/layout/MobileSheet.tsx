"use client";

import { useEffect, useState } from "react";
import { PANELS, type PanelId } from "@/lib/panels";
import { PANEL_CONTENT, type PanelCtx } from "@/components/panels/panelContent";
import { useExplorer } from "@/lib/store";

export function MobileSheet({ ctx }: { ctx: PanelCtx }) {
  const [active, setActive] = useState<PanelId>("overview");
  const [open, setOpen] = useState(true);
  const selectedId = useExplorer((s) => s.selectedId);

  useEffect(() => {
    if (selectedId !== null) {
      // Reacting to an external selection event (tapping/searching an object elsewhere on the
      // page), not deriving state from a prop on every render — same justification as
      // ObjectCard's identical disable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive("search");
      setOpen(true);
    }
  }, [selectedId]);

  return (
    <div data-testid="mobile-sheet" className="panel fixed inset-x-2 bottom-2 z-20 max-h-[60dvh] !p-0">
      <div role="tablist" aria-label="Panels" className="flex gap-1 overflow-x-auto border-b-2 border-line px-2 py-2">
        {PANELS.map((p) => (
          <button
            key={p.id}
            role="tab"
            type="button"
            aria-selected={active === p.id}
            onClick={() => {
              setActive(p.id);
              setOpen(true);
            }}
            className={`shrink-0 rounded-full px-3 py-1 text-[13px] ${active === p.id ? "bg-[#1c1c1c] text-ink" : "text-ink-2"}`}
          >
            {p.title}
          </button>
        ))}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse panel" : "Expand panel"} className="ml-auto shrink-0 px-2 text-ink-2">
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && <div role="tabpanel" aria-label={PANELS.find((p) => p.id === active)!.title} className="max-h-[calc(60dvh-52px)] overflow-y-auto p-3">{PANEL_CONTENT[active](ctx)}</div>}
    </div>
  );
}
