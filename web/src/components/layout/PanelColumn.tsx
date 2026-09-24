"use client";

import { useEffect, useRef } from "react";

/** A desktop panel column. When its panels don't fit the viewport it scrolls, and fades out the
 * edge(s) with more content (`data-more-above` / `data-more-below`, styled in globals.css) — a
 * cue that doesn't depend on the platform showing a scrollbar (overlay scrollbars on macOS or
 * touch screens are invisible until you scroll). */
export function PanelColumn({ side, className, children }: { side: "left" | "right"; className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.toggleAttribute("data-more-above", el.scrollTop > 1);
      el.toggleAttribute("data-more-below", el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    };
    // The column itself is fixed-size; its content grows/shrinks as panels load, open or hide.
    const ro = new ResizeObserver(update);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(el);
      for (const child of el.querySelectorAll("*")) if (child.parentElement === el || child.hasAttribute("data-panel")) ro.observe(child);
      update();
    };
    const mo = new MutationObserver(observeAll);
    mo.observe(el, { childList: true, subtree: true });
    observeAll();
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  return (
    <div ref={ref} data-col={side} className={`panel-col ${className}`}>
      {children}
    </div>
  );
}
