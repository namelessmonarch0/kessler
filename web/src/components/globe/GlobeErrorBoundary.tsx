"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Called once, synchronously with the catch, so the parent can swap in its no-WebGL-style
   * fallback message in the right place in its own layout (this boundary only wraps <Canvas>,
   * not the surrounding overlay text). */
  onError: () => void;
}
interface State {
  hasError: boolean;
}

/**
 * Catches any render-time throw from the WebGL/shader/R3F tree beneath it — a
 * driver quirk, a bad shader compile, an out-of-memory texture, or anything else three/R3F
 * throws during render/commit — so it takes down only the globe card instead of the whole page
 * (spec §7, review focus 1 and 4).
 *
 * React error boundaries only catch errors thrown during render/commit. `webglcontextlost` is a
 * native browser event on the canvas, not a thrown error, so it can't be caught here — see
 * GlobeSection's own `webglcontextlost` listener for that case.
 */
export class GlobeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("Globe render failed:", error);
    this.props.onError();
  }

  render(): ReactNode {
    // Render nothing in place of the broken <Canvas>; the parent renders the actual fallback
    // message alongside the rest of its overlay once onError has fired.
    return this.state.hasError ? null : this.props.children;
  }
}
