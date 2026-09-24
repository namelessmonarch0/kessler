import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Departure Mono is the only typeface on the site (see globals.css: --font-sans and --font-mono
// both resolve to it) — Inter Tight was dropped, so its files are never fetched.
const departure = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kessler",
  description: "Every tracked object in Earth orbit, 1957 to now: a live map, and the history of how it got crowded.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={departure.variable}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
