import { fmtDate } from "@/lib/format";
import type { Meta } from "@/lib/types";

export const ATTRIBUTION = "Data: USSPACECOM via Space-Track.org; CelesTrak.";

export function Footer({ meta }: { meta?: Meta | null }) {
  const asOf = meta?.data_as_of.gp ?? meta?.data_as_of.satcat ?? null;
  return (
    <footer className="mt-10 border-t border-line py-6 text-ink-3">
      <p className="font-mono text-[12px]">{ATTRIBUTION}{asOf ? ` Updated ${fmtDate(asOf)}.` : ""}</p>
      <p className="mt-1 text-[13px]">Built by Kuday Yurter from a 1st-place MATLAB project. Only objects ≥ 10 cm are tracked.</p>
    </footer>
  );
}
