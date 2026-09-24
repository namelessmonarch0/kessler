"use client";

import { useEffect, useRef, useState } from "react";
import { PANELS, type PanelId } from "@/lib/panels";
import { PANEL_CONTENT, type PanelCtx } from "@/components/panels/panelContent";
import { useExplorer } from "@/lib/store";

/** `showBody` is false during the server render / hydration pass (the layout isn't known yet and
 * the desktop columns hold the panel bodies then — see page.tsx), so only the tab bar paints. */
export function MobileSheet({ ctx, showBody = true }: { ctx: PanelCtx; showBody?: boolean }) {
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

  // Publishes the sheet's real rendered top edge: with the top bar's bottom edge (measured in
  // GlobeSection) it bounds the part of the globe left visible, which GlobeScene centres the Earth
  // in (camera.ts sheetViewOffset) and LabelDriver restricts labels to. A ResizeObserver catches
  // every case the top can change (open/collapse, active tab, content load) since this element is
  // bottom-anchored — its own height change is exactly what moves its top. Only once the layout is
  // known (`showBody`): before that this shell may be display:none (desktop first paint).
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !showBody) return;
    const update = () => setSheetTop(el.getBoundingClientRect().top);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      setSheetTop(null);
    };
  }, [setSheetTop, showBody]);

  return (
    <div ref={sheetRef} data-testid="mobile-sheet" className="panel fixed inset-x-2 bottom-2 z-20 mx-auto max-h-[60dvh] max-w-[640px] !p-0 short:max-h-[50dvh] wide:hidden">
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
      {open && showBody && (
        <div role="tabpanel" aria-label={PANELS.find((p) => p.id === active)!.title} className="max-h-[calc(60dvh-52px)] overflow-y-auto p-3 short:max-h-[calc(50dvh-52px)]">
          {PANEL_CONTENT[active](ctx)}
        </div>
      )}
    </div>
  );
}
