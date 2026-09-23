import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const inter = Inter_Tight({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const departure = localFont({
  src: "./fonts/DepartureMono-Regular.woff2",
  variable: "--font-departure",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LEO Debris",
  description: "A live map of every tracked object in low Earth orbit, with the history of how it got crowded.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${departure.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
