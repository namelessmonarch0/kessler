"use client";

import { animate, createDrawable, stagger } from "animejs";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { useEffect, useRef, useState } from "react";
import { ANNOTATIONS, visibleTypeSeries } from "@/lib/chartData";
import { fmtInt } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import { TYPE_COLORS, TYPE_LABELS, type TimeseriesResponse } from "@/lib/types";
import { niceMax, yTicks } from "@/components/charts/scales";

const H = 330;
const M = { t: 30, r: 118, b: 28, l: 52 };

export function LineChart({ data }: { data: TimeseriesResponse }) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const series = visibleTypeSeries(data);
  const years = data.years;
  const x = scaleLinear().domain([years[0], years[years.length - 1]]).range([M.l, width - M.r]);
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const y = scaleLinear().domain([0, yMax]).range([H - M.b, M.t]);
  const path = line<number>().x((_, i) => x(years[i])).y((v) => y(v)).curve(curveMonotoneX);
  const narrow = width < 520;

  useEffect(() => {
    const el = svg.current;
    if (!el || prefersReducedMotion()) return;
    const paths = el.querySelectorAll<SVGPathElement>("path[data-series]");
    paths.forEach((p) => (p.style.opacity = "0"));
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        paths.forEach((p) => (p.style.opacity = "1"));
        animate(createDrawable(Array.from(paths)), {
          draw: ["0 0", "0 1"],
          duration: 1800,
          delay: stagger(200),
          ease: "inOutQuad",
        });
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [data]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const year = Math.round(x.invert(e.clientX - rect.left + M.l));
    const i = years.indexOf(year);
    if (i >= 0) setHover({ i, x: e.clientX, y: e.clientY });
  };

  return (
    <div ref={wrap} className="relative">
      <div className="mb-2 flex flex-wrap gap-4 text-[13px] text-ink-2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-2">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: TYPE_COLORS[s.key] }} />
            {TYPE_LABELS[s.key]}
          </span>
        ))}
      </div>
      <svg ref={svg} width={width} height={H} role="img" aria-label="Objects in orbit per year by type" className="block max-w-full">
        {yTicks(yMax).map((t) => (
          <g key={t}>
            <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke="#1e1e1e" />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fill-ink-3 font-mono text-[12px]">
              {fmtInt(t)}
            </text>
          </g>
        ))}
        {[years[0], ...years.filter((yr) => yr % 20 === 0), years[years.length - 1]]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((yr) => (
            <text key={yr} x={x(yr)} y={H - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[12px]">
              {yr}
            </text>
          ))}
        {!narrow &&
          ANNOTATIONS.filter((a) => a.year >= years[0] && a.year <= years[years.length - 1]).map((a) => (
            <g key={a.year}>
              <line x1={x(a.year)} x2={x(a.year)} y1={M.t + a.row * 14} y2={H - M.b} stroke="#3a3a3a" strokeDasharray="3 4" />
              <text x={x(a.year) - 4} y={M.t - 8 + a.row * 14} textAnchor="end" className="fill-ink-2 font-mono text-[12px]">
                {a.label}
              </text>
            </g>
          ))}
        {series.map((s) => (
          <path key={s.key} data-series={s.key} d={path(s.values) ?? ""} fill="none" stroke={TYPE_COLORS[s.key]} strokeWidth={2.5} strokeLinecap="round" />
        ))}
        {series.map((s) => {
          const v = s.values[s.values.length - 1];
          return (
            <g key={s.key}>
              <circle cx={x(years[years.length - 1])} cy={y(v)} r={4.5} fill={TYPE_COLORS[s.key]} stroke="#0e0e0e" strokeWidth={2} />
              <text x={x(years[years.length - 1]) + 10} y={y(v) + 4} className="fill-ink font-mono text-[12px]">
                {fmtInt(v)}
              </text>
            </g>
          );
        })}
        {hover && <line x1={x(years[hover.i])} x2={x(years[hover.i])} y1={M.t} y2={H - M.b} stroke="#555" />}
        <rect
          x={M.l}
          y={M.t}
          width={width - M.l - M.r}
          height={H - M.t - M.b}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover && (
        <div
          className="pointer-events-none fixed z-10 min-w-40 rounded-[10px] border-2 border-[#333] bg-[#161616] px-3 py-2.5 text-[12px] shadow-[3px_3px_0_#0a0a0a]"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          <div className="font-mono text-ink">{years[hover.i]}</div>
          {series.map((s) => (
            <div key={s.key} className="mt-1 flex justify-between gap-4 text-ink-2">
              <span>{TYPE_LABELS[s.key]}</span>
              <b className="font-medium text-ink">{fmtInt(s.values[hover.i])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
