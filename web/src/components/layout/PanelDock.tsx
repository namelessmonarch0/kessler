"use client";

import { PANELS } from "@/lib/panels";
import { useExplorer } from "@/lib/store";

export function PanelDock() {
  const panels = useExplorer((s) => s.panels);
  const togglePanel = useExplorer((s) => s.togglePanel);
  return (
    <nav aria-label="Panels" data-testid="panel-dock" className="pointer-events-auto flex max-w-full flex-wrap justify-center gap-1.5">
      {PANELS.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={panels[p.id]}
          onClick={() => togglePanel(p.id)}
          className={`rounded-full border px-3 py-1 text-[13px] font-semibold backdrop-blur ${panels[p.id] ? "border-ink/70 bg-[#141414]/90 text-ink" : "border-line bg-[#0b0b0b]/80 text-ink-3"}`}
        >
          {p.title}
        </button>
      ))}
    </nav>
  );
}
