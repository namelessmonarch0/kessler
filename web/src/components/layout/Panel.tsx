"use client";

import type { PanelId } from "@/lib/panels";
import { useExplorer } from "@/lib/store";

export function Panel({ id, title, children, className = "" }: { id: PanelId; title: string; children: React.ReactNode; className?: string }) {
  const shown = useExplorer((s) => s.panels[id]);
  const setPanel = useExplorer((s) => s.setPanel);
  if (!shown) return null;
  return (
    <section className={`panel ${className}`} aria-label={title} data-panel={id}>
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[14px] text-ink">{title}</h2>
        <button type="button" onClick={() => setPanel(id, false)} aria-label={`Hide ${title}`} className="px-1 text-[16px] leading-none text-ink-2 hover:text-ink">×</button>
      </header>
      {children}
    </section>
  );
}
