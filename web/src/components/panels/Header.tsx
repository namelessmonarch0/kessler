import Link from "next/link";
import { PixelIcon } from "@/components/ui/PixelIcon";

export function Header() {
  return (
    <header className="flex items-center justify-between py-5">
      <Link href="/" className="flex items-center gap-2.5 font-mono text-[15px] text-ink">
        <PixelIcon name="sat" size={18} color="#3987e5" /> LEO / DEBRIS
      </Link>
      <nav className="flex gap-5 text-sm text-ink-2">
        <Link href="/#explore" className="hover:text-ink">Explore</Link>
        <Link href="/about" className="hover:text-ink">About</Link>
        <a href="https://kudayyurter.dev" className="hover:text-ink">kudayyurter.dev ↗</a>
      </nav>
    </header>
  );
}
