"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CountryStat } from "@/lib/shipping-metrics";

const BAR_COLOR = "#1baf7a"; // aqua-600 — distinct from carrier chart's blue

function TooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: CountryStat }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const c = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-slate-900">{c.country}</div>
      <div className="mt-1 space-y-0.5 text-slate-600">
        <div>Avg: {c.avg.toFixed(1)}d</div>
        <div>{c.count.toLocaleString("en-US")} orders</div>
      </div>
    </div>
  );
}

export function DestinationChart({ data }: { data: CountryStat[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">Destination Performance</h3>
      <p className="mb-3 text-xs text-slate-500">
        Top 10 countries by order count, avg total delivery time
      </p>

      {data.length === 0 ? (
        <div className="flex h-52 items-center justify-center text-sm text-slate-400">
          Not enough data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(220, data.length * 32)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 40, left: 8, bottom: 0 }}
            barCategoryGap={8}
          >
            <CartesianGrid stroke="#e1e0d9" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "#898781" }}
              axisLine={{ stroke: "#c3c2b7" }}
              tickLine={false}
              tickFormatter={(v: number) => `${v}d`}
            />
            <YAxis
              type="category"
              dataKey="country"
              tick={{ fontSize: 12, fill: "#52514e" }}
              axisLine={false}
              tickLine={false}
              width={110}
            />
            <Tooltip content={<TooltipContent />} cursor={{ fill: "#f9f9f7" }} />
            <Bar dataKey="avg" radius={[0, 4, 4, 0]} maxBarSize={20}>
              {data.map((c) => (
                <Cell key={c.country} fill={BAR_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
