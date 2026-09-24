import Link from "next/link";
import { GLOBE_COLORS } from "@/lib/types";
import { PixelIcon } from "@/components/ui/PixelIcon";

export function Header() {
  return (
    <header className="flex flex-col items-start gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
      <Link href="/" className="flex items-center gap-2.5 whitespace-nowrap font-mono text-[15px] text-ink">
        <PixelIcon name="sat" size={18} color={GLOBE_COLORS.PAY} /> KESSLER
      </Link>
      <nav className="flex items-center gap-5 text-sm text-ink-2">
        <Link href="/" className="py-1 hover:text-ink">Explore</Link>
        <Link href="/about" className="py-1 hover:text-ink">About</Link>
        <a href="https://kudayyurter.dev" className="py-1 hover:text-ink">kudayyurter.dev ↗</a>
      </nav>
    </header>
  );
}
