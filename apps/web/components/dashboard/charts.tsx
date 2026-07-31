"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart as RAreaChart,
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/** Compact number for axes/tooltips (2800 → "2.8K"). */
export function compact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000)
    return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 1000)
    return `${(n / 1000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

/** Resolve an OKLch CSS token to a canvas-normalized color (recharts SVG attrs
 * don't reliably resolve oklch / var()). */
function resolveColor(varName: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) return fallback;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return fallback;
  ctx.fillStyle = fallback;
  ctx.fillStyle = raw;
  return ctx.fillStyle;
}

function useChartColors() {
  const [colors, setColors] = useState({
    brand: "#2349f4",
    border: "rgba(0,0,0,0.08)",
    muted: "#777777",
    bg: "#ffffff",
  });
  useEffect(() => {
    const read = () =>
      setColors({
        brand: resolveColor("--brand", "#2349f4"),
        border: resolveColor("--border", "rgba(0,0,0,0.08)"),
        muted: resolveColor("--muted-foreground", "#777777"),
        bg: resolveColor("--background", "#ffffff"),
      });
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return colors;
}

const tooltipBox =
  "rounded-lg bg-popover p-2.5 text-xs shadow-lg ring-1 ring-foreground/10";

type Datum = Record<string, string | number>;

/** Tremor-style area chart (Recharts). `tooltip` renders the active data row. */
export function AreaChart({
  data,
  index,
  valueKey = "value",
  height = 176,
  valueFormatter = compact,
  tooltip,
}: {
  data: Datum[];
  index: string;
  valueKey?: string;
  height?: number;
  valueFormatter?: (n: number) => string;
  tooltip?: (row: Datum) => React.ReactNode;
}) {
  const c = useChartColors();
  const gid = useId().replace(/:/g, "");
  return (
    <ResponsiveContainer height={height} width="100%">
      <RAreaChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={c.brand} stopOpacity={0.22} />
            <stop offset="100%" stopColor={c.brand} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid horizontal stroke={c.border} strokeDasharray="3 5" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={index}
          minTickGap={28}
          tick={{ fill: c.muted, fontSize: 10 }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tick={{ fill: c.muted, fontSize: 10 }}
          tickFormatter={valueFormatter}
          tickLine={false}
          width={36}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as Datum;
            if (tooltip) return <div className={tooltipBox}>{tooltip(row)}</div>;
            return (
              <div className={tooltipBox}>
                <p className="font-mono text-muted-foreground">{row[index]}</p>
                <p className="mt-1 font-mono text-foreground">
                  {valueFormatter(Number(row[valueKey] ?? 0))}
                </p>
              </div>
            );
          }}
          cursor={{ stroke: c.muted, strokeOpacity: 0.3 }}
        />
        <Area
          activeDot={{ fill: c.brand, r: 4, stroke: c.bg, strokeWidth: 2 }}
          dataKey={valueKey}
          dot={false}
          fill={`url(#${gid})`}
          stroke={c.brand}
          strokeWidth={2}
          type="monotone"
        />
      </RAreaChart>
    </ResponsiveContainer>
  );
}

/** Tremor-style multi-series line chart (Recharts). One line per category,
 * each colored from a CSS token var (e.g. "--brand"). */
export function LineChart({
  data,
  index,
  categories,
  height = 176,
  valueFormatter = compact,
  tooltip,
}: {
  data: Datum[];
  index: string;
  categories: Array<{ key: string; label: string; color: string }>;
  height?: number;
  valueFormatter?: (n: number) => string;
  tooltip?: (row: Datum) => React.ReactNode;
}) {
  const c = useChartColors();
  const lineColors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const cat of categories) m[cat.key] = resolveColor(cat.color, c.brand);
    return m;
  }, [categories, c.brand]);

  return (
    <ResponsiveContainer height={height} width="100%">
      <RLineChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal stroke={c.border} strokeDasharray="3 5" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={index}
          minTickGap={28}
          tick={{ fill: c.muted, fontSize: 10 }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tick={{ fill: c.muted, fontSize: 10 }}
          tickFormatter={valueFormatter}
          tickLine={false}
          width={36}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as Datum;
            if (tooltip) return <div className={tooltipBox}>{tooltip(row)}</div>;
            return null;
          }}
          cursor={{ stroke: c.muted, strokeOpacity: 0.3 }}
        />
        {categories.map((cat) => (
          <Line
            activeDot={{ r: 3.5, stroke: c.bg, strokeWidth: 2 }}
            dataKey={cat.key}
            dot={false}
            key={cat.key}
            stroke={lineColors[cat.key] ?? c.brand}
            strokeWidth={2}
            type="monotone"
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
  );
}

/** Tremor-style bar chart (Recharts). */
export function BarChart({
  data,
  index,
  valueKey = "value",
  height = 112,
  showYAxis = false,
  valueFormatter = compact,
  tooltip,
}: {
  data: Datum[];
  index: string;
  valueKey?: string;
  height?: number;
  showYAxis?: boolean;
  valueFormatter?: (n: number) => string;
  tooltip?: (row: Datum) => React.ReactNode;
}) {
  const c = useChartColors();
  return (
    <ResponsiveContainer height={height} width="100%">
      <RBarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal stroke={c.border} strokeDasharray="3 5" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={index}
          minTickGap={20}
          tick={{ fill: c.muted, fontSize: 10 }}
          tickLine={false}
        />
        {showYAxis ? (
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tick={{ fill: c.muted, fontSize: 10 }}
            tickFormatter={valueFormatter}
            tickLine={false}
            width={34}
          />
        ) : null}
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as Datum;
            if (tooltip) return <div className={tooltipBox}>{tooltip(row)}</div>;
            return (
              <div className={tooltipBox}>
                <p className="font-mono text-muted-foreground">{row[index]}</p>
                <p className="mt-1 font-mono text-foreground">
                  {valueFormatter(Number(row[valueKey] ?? 0))}
                </p>
              </div>
            );
          }}
          cursor={{ fill: c.muted, fillOpacity: 0.08 }}
        />
        <Bar
          activeBar={false}
          dataKey={valueKey}
          fill={c.brand}
          radius={[2, 2, 0, 0]}
        />
      </RBarChart>
    </ResponsiveContainer>
  );
}
