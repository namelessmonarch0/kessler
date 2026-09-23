import type { Metadata } from "next";
import { Footer } from "@/components/panels/Footer";
import { Header } from "@/components/panels/Header";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "About · LEO Debris",
  description: "How this site was built, where the data comes from, and the MATLAB project it started as.",
};

const TEAM = ["Brian Alino", "Meena Al Hasani", "Gregory Maddox", "Vedant Patel", "Jessica Semaan", "Kuday Yurter"];

export default function About() {
  return (
    <main className="mx-auto max-w-[860px] px-4 pb-10 sm:px-7">
      <Header />
      <div className="flex flex-col gap-5">
        <Card>
          <h1 className="font-mono text-[28px] text-ink">From a MATLAB app to a live map</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
            This site started as <em>Space Debris and Objects in LEO</em>, a MATLAB App Designer project that won
            1st place. It charted debris, rocket bodies and payloads from China, Russia and the US between 1997
            and 2022, with a globe of randomly placed dots. This version covers every tracked object and owner
            from 1957 to today, places each object at its real position, and refreshes several times a day.
          </p>
          <p className="label mt-4">Original team</p>
          <p className="mt-1 text-[15px] text-ink">{TEAM.join(", ")}</p>
          <p className="mt-3 text-[13px] text-ink-2">
            Original code: <a className="underline hover:text-ink" href="https://github.com/namelessmonarch0/DebrisInLEO">github.com/namelessmonarch0/DebrisInLEO</a>
          </p>
        </Card>
        <Card>
          <h2 className="font-mono text-[18px] text-ink">How the numbers are counted</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-ink-2">
            <li>The catalog lists every object tracked since Sputnik in 1957, including about 35,000 that have already re-entered.</li>
            <li>An object counts as &ldquo;in orbit&rdquo; in a year if it was first seen by then and had not re-entered by the end of that year.</li>
            <li>Debris is dated by when it appeared, not by its parent&apos;s launch. Fragments from known breakups (Fengyun-1C in 2007, Iridium–Cosmos in 2009, Kosmos 1408 in 2021, and others) are dated to the event.</li>
            <li>Low Earth orbit here means an apogee below 2,000 km.</li>
            <li>Positions are computed in your browser from published orbital elements with the SGP4 model; the day/night line follows the real Sun.</li>
            <li>Only objects about 10 cm and larger are tracked. Estimates put the number of 1–10 cm pieces near a million.</li>
          </ul>
        </Card>
        <Card>
          <h2 className="font-mono text-[18px] text-ink">Sources</h2>
          <ul className="mt-3 space-y-2 text-[15px] text-ink-2">
            <li>Orbital elements and catalog: USSPACECOM via <a className="underline hover:text-ink" href="https://www.space-track.org">Space-Track.org</a> and <a className="underline hover:text-ink" href="https://celestrak.org">CelesTrak</a>.</li>
            <li>Coastlines: <a className="underline hover:text-ink" href="https://www.naturalearthdata.com">Natural Earth</a> via world-atlas.</li>
            <li>Typeface: Departure Mono by Helena Zhang (SIL Open Font License) and Inter Tight.</li>
          </ul>
        </Card>
      </div>
      <Footer />
    </main>
  );
}
