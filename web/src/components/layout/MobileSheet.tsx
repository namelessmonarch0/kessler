"use client";

import { useEffect, useRef, useState } from "react";
import { PANELS, type PanelId } from "@/lib/panels";
import { PANEL_CONTENT, type PanelCtx } from "@/components/panels/panelContent";
import { useExplorer } from "@/lib/store";

export function MobileSheet({ ctx }: { ctx: PanelCtx }) {
  const [active, setActive] = useState<PanelId>("overview");
  const selectedId = useExplorer((s) => s.selectedId);
  // Lives in the store (not local state) so GlobeScene, inside the <Canvas> tree elsewhere in the
  // page, can read it too and keep the globe framed above the sheet while it's open.
  const open = useExplorer((s) => s.mobileSheetOpen);
  const setOpen = useExplorer((s) => s.setMobileSheetOpen);
  const setSheetTop = useExplorer((s) => s.setMobileSheetTop);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedId !== null) {
      // Reacting to an external selection event (tapping/searching an object elsewhere on the
      // page), not deriving state from a prop on every render — same justification as
      // ObjectCard's identical disable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive("search");
      setOpen(true);
    }
  }, [selectedId, setOpen]);

  // Publishes the sheet's real rendered top edge so GlobeScene can frame the globe against how
  // much space the sheet *actually* takes — its height is content-driven (`max-h-[60dvh]` is only
  // a ceiling: the short Overview tab renders much shorter than the taller History chart), so a
  // fixed assumption from that CSS max was wrong (see camera.ts's coveredHeightFromSheetTop). A
  // ResizeObserver catches every case the top can change (open/collapse, active tab, content
  // load) since this element is bottom-anchored — its own height change is exactly what moves its
  // top. Relies on the observer's own initial callback (always fired once, async, right after
  // `observe()`) rather than an extra synchronous call here, so there's no synchronous setState
  // in the effect body to justify.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const update = () => setSheetTop(el.getBoundingClientRect().top);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      setSheetTop(null);
    };
  }, [setSheetTop]);

  return (
    <div ref={sheetRef} data-testid="mobile-sheet" className="panel fixed inset-x-2 bottom-2 z-20 max-h-[60dvh] !p-0">
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
        <button type="button" onClick={() => setOpen(!open)} aria-label={open ? "Collapse panel" : "Expand panel"} className="ml-auto shrink-0 px-2 text-ink-2">
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && <div role="tabpanel" aria-label={PANELS.find((p) => p.id === active)!.title} className="max-h-[calc(60dvh-52px)] overflow-y-auto p-3">{PANEL_CONTENT[active](ctx)}</div>}
    </div>
  );
}
