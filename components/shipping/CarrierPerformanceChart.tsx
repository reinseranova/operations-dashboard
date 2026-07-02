"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CarrierStat } from "@/lib/shipping-metrics";

const BAR_COLOR = "#2563eb"; // blue-600 — single series, no legend needed

function TooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: CarrierStat }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const c = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-medium capitalize text-slate-900">{c.carrier}</div>
      <div className="mt-1 space-y-0.5 text-slate-600">
        <div>Avg: {c.avg.toFixed(1)}d</div>
        <div>P85: {c.p85 === null ? "—" : `${c.p85.toFixed(1)}d`}</div>
        <div>{c.count.toLocaleString("en-US")} orders</div>
      </div>
    </div>
  );
}

export function CarrierPerformanceChart({ data }: { data: CarrierStat[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">Carrier Performance</h3>
      <p className="mb-3 text-xs text-slate-500">Avg transit time per carrier, fastest first</p>

      {data.length < 2 ? (
        <div className="flex h-52 items-center justify-center text-sm text-slate-400">
          Not enough carrier variety in this period
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 40)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 40, left: 8, bottom: 0 }}
            barCategoryGap={10}
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
              dataKey="carrier"
              tick={{ fontSize: 12, fill: "#52514e" }}
              axisLine={false}
              tickLine={false}
              width={90}
              className="capitalize"
            />
            <Tooltip content={<TooltipContent />} cursor={{ fill: "#f9f9f7" }} />
            <Bar dataKey="avg" radius={[0, 4, 4, 0]} maxBarSize={24}>
              {data.map((c) => (
                <Cell key={c.carrier} fill={BAR_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
