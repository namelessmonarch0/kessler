"use client";

import { useSyncExternalStore } from "react";

/** The bottom-sheet layout applies whenever the viewport is narrower than 1024px OR shorter than
 * 560px; the two-column desktop layout only at >= 1024x560. Must match the `sheet` / `wide`
 * custom variants in globals.css, which pick the layout for first paint (before hydration). */
export const SHEET_QUERY = "(max-width: 1023px), (max-height: 559px)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(SHEET_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** true = bottom-sheet layout, false = desktop columns, null = not known yet (server render and
 * the hydration pass — CSS decides what's visible until then). */
export function useSheetLayout(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, () => window.matchMedia(SHEET_QUERY).matches, () => null);
}

/** Client-only components (e.g. inside the WebGL <Canvas>, never server-rendered) that just need
 * a yes/no answer. */
export function useIsMobile(): boolean {
  return useSheetLayout() === true;
}
