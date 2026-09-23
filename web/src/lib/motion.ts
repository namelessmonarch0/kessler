import { animate } from "animejs";
import { fmtInt } from "@/lib/format";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function countUp(el: HTMLElement, to: number, delayMs = 0): void {
  if (prefersReducedMotion()) {
    el.textContent = fmtInt(to);
    return;
  }
  const o = { v: 0 };
  animate(o, {
    v: to,
    duration: 1600,
    delay: delayMs,
    ease: "outExpo",
    onUpdate: () => {
      el.textContent = fmtInt(Math.round(o.v));
    },
  });
}
