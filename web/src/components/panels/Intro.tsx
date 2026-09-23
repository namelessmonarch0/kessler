import { Card } from "@/components/ui/Card";

export function Intro() {
  return (
    <Card>
      <h1 className="font-mono text-[28px] leading-tight text-ink sm:text-[34px]">Low Earth orbit is getting crowded.</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        Every tracked satellite, rocket body and fragment within 2,000 km of Earth, moving live. Click an object to
        see what it is, or scroll down to see how we got here.
      </p>
    </Card>
  );
}
