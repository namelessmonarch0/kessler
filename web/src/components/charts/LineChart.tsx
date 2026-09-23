"use client";

import { animate, createDrawable, stagger } from "animejs";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ANNOTATIONS, visibleTypeSeries } from "@/lib/chartData";
import { fmtInt } from "@/lib/format";
import { prefersReducedMotion } from "@/lib/motion";
import { TYPE_COLORS, TYPE_LABELS, type TimeseriesResponse } from "@/lib/types";
import { CHAR_W, layoutAnnotations, niceMax, tooltipPosition, yearTicks, yTicks } from "@/components/charts/scales";

const H = 330;
const M_BASE = { t: 30, r: 118, b: 28 };
const ANNOT_ROW_H = 14;

export function LineChart({ data }: { data: TimeseriesResponse }) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [tipSize, setTipSize] = useState({ w: 200, h: 90 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // 320 as a floor overflowed its own container at 390px viewport widths (a 314px-wide card,
    // per review) — 260 is comfortably below any real card width this chart renders in while
    // still keeping the plot legible.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (hover && tipRef.current) {
      const r = tipRef.current.getBoundingClientRect();
      if (r.width && r.height) setTipSize({ w: r.width, h: r.height });
    }
  }, [hover]);

  const series = visibleTypeSeries(data);
  const years = data.years;
  // Left margin sized from the widest formatted y-tick label (e.g. "20,000"), not a fixed guess —
  // a fixed 52px margin clipped the leading glyph of 6-character labels at Departure Mono's
  // measured advance width (CHAR_W ≈ 7.64px/char).
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const yTickValues = yTicks(yMax);
  const maxTickLen = Math.max(0, ...yTickValues.map((t) => fmtInt(t).length));
  const M = { ...M_BASE, l: Math.ceil(maxTickLen * CHAR_W) + 14 };
  const x = scaleLinear().domain([years[0], years[years.length - 1]]).range([M.l, width - M.r]);
  const narrow = width < 520;
  const annotationItems = narrow ? [] : ANNOTATIONS.filter((a) => a.year >= years[0] && a.year <= years[years.length - 1]);
  const laidOutAnnotations = layoutAnnotations(annotationItems, (yr) => x(yr), M.l, width - M.r);
  const maxAnnotationRow = laidOutAnnotations.reduce((m, a) => Math.max(m, a.row), 0);
  const top = M.t + maxAnnotationRow * ANNOT_ROW_H;
  const y = scaleLinear().domain([0, yMax]).range([H - M.b, top]);
  const path = line<number>().x((_, i) => x(years[i])).y((v) => y(v)).curve(curveMonotoneX);

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

  const tipPos = hover ? tooltipPosition(hover.x, hover.y, window.innerWidth, window.innerHeight, tipSize.w, tipSize.h) : null;

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
        {yTickValues.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke="#1e1e1e" />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fill-ink-3 font-mono text-[12px]">
              {fmtInt(t)}
            </text>
          </g>
        ))}
        {yearTicks(years[0], years[years.length - 1], (yr) => x(yr)).map((yr) => (
          <text key={yr} x={x(yr)} y={H - 6} textAnchor="middle" className="fill-ink-3 font-mono text-[12px]">
            {yr}
          </text>
        ))}
        {laidOutAnnotations.map((a) => (
          <g key={a.year}>
            <line x1={a.x} x2={a.x} y1={M.t + a.row * ANNOT_ROW_H} y2={H - M.b} stroke="#3a3a3a" strokeDasharray="3 4" />
            <text
              x={a.anchor === "end" ? a.x - 4 : a.x + 4}
              y={M.t - 8 + a.row * ANNOT_ROW_H}
              textAnchor={a.anchor}
              className="fill-ink-2 font-mono text-[12px]"
            >
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
        {hover && <line x1={x(years[hover.i])} x2={x(years[hover.i])} y1={top} y2={H - M.b} stroke="#555" />}
        <rect
          x={M.l}
          y={top}
          width={width - M.l - M.r}
          height={H - top - M.b}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover && tipPos && (
        <div
          ref={tipRef}
          className="pointer-events-none fixed z-10 min-w-40 rounded-[10px] border-2 border-[#333] bg-[#161616] px-3 py-2.5 text-[12px] shadow-[3px_3px_0_#0a0a0a]"
          style={{ left: tipPos.left, top: tipPos.top }}
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
