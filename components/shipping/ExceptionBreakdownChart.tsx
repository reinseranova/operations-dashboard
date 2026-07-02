"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EXCEPTION_CATEGORY_ORDER, type ExceptionBucketRow } from "@/lib/shipping-metrics";
import { PillGroup } from "./LocationToggle";

// Fixed stacking/legend order — colors never re-sorted by value. Warm/cool
// hues alternate so adjacent stack segments stay distinguishable.
const CATEGORY_COLORS: Record<(typeof EXCEPTION_CATEGORY_ORDER)[number], string> = {
  Lost: "#dc2626", // red-600
  Damaged: "#0d9488", // teal-600
  "Customs Hold": "#d97706", // amber-600
  Returned: "#7c3aed", // violet-600
  "Address Issue": "#65a30d", // lime-600
  "Recipient Unavailable": "#0284c7", // sky-600
  "Failed Attempt": "#c026d3", // fuchsia-600
  "Weather Delay": "#ea580c", // orange-600
  Other: "#94a3b8", // slate-400
};
const CUSTOMS_DELAY_COLOR = "#4f46e5"; // indigo-600 — overlay line, distinct from stack hues

type Mode = "count" | "percent";

export function ExceptionBreakdownChart({
  data,
  shipmentCounts,
  isChina,
}: {
  data: ExceptionBucketRow[];
  shipmentCounts: Record<string, number>;
  isChina: boolean;
}) {
  const [mode, setMode] = useState<Mode>("count");

  const chartData = useMemo(() => {
    return data.map((row) => {
      const shipments = shipmentCounts[row.bucket] ?? 0;
      const toValue = (n: number) =>
        mode === "percent" && shipments > 0 ? (n / shipments) * 100 : n;
      const entry: Record<string, string | number> = { label: row.label };
      for (const cat of EXCEPTION_CATEGORY_ORDER) entry[cat] = toValue(row.counts[cat] ?? 0);
      if (isChina) entry.customsDelays = toValue(row.customsDelays ?? 0);
      return entry;
    });
  }, [data, shipmentCounts, mode, isChina]);

  const hasData = data.some(
    (row) => Object.values(row.counts).some((c) => c > 0) || (row.customsDelays ?? 0) > 0,
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Exception Breakdown</h3>
        <PillGroup<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "count", label: "Show as count" },
            { value: "percent", label: "Show as % of shipments" },
          ]}
        />
      </div>

      {!hasData ? (
        <div className="flex h-52 items-center justify-center text-sm text-slate-400">
          No exceptions recorded in this period
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e1e0d9" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#898781" }}
              axisLine={{ stroke: "#c3c2b7" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#898781" }}
              axisLine={false}
              tickLine={false}
              width={36}
              tickFormatter={(v: number) => (mode === "percent" ? `${v}%` : `${v}`)}
            />
            <Tooltip
              formatter={(value, name) => [
                mode === "percent"
                  ? `${Number(value).toFixed(1)}%`
                  : Number(value).toLocaleString("en-US"),
                String(name),
              ]}
              contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#e1e0d9" }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "#52514e" }} />
            {EXCEPTION_CATEGORY_ORDER.map((cat) => (
              <Bar
                key={cat}
                dataKey={cat}
                stackId="exceptions"
                name={cat}
                fill={CATEGORY_COLORS[cat]}
                maxBarSize={24}
              />
            ))}
            {isChina && (
              <Line
                type="monotone"
                dataKey="customsDelays"
                name="Customs Delays"
                stroke={CUSTOMS_DELAY_COLOR}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
