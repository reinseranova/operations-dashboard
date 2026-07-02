"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeSeriesBucket } from "@/lib/shipping-metrics";

// Average and P85 are two views of the same metric, so they share one hue at
// two lightness steps (sequential, not two unrelated categorical colors).
const AVG_COLOR = "#2563eb"; // blue-600
const P85_COLOR = "#93c5fd"; // blue-300

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimeSeriesBucket }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-slate-900">{label}</div>
      <div className="mt-1 space-y-0.5 text-slate-600">
        <div>Avg: {point.avg === null ? "—" : `${point.avg.toFixed(1)}d`}</div>
        <div>P85: {point.p85 === null ? "—" : `${point.p85.toFixed(1)}d`}</div>
        <div>{point.count.toLocaleString("en-US")} shipments</div>
      </div>
    </div>
  );
}

export function DeliveryTrendChart({
  title,
  subtitle,
  data,
  height = 260,
}: {
  title: string;
  subtitle?: string;
  data: TimeSeriesBucket[];
  height?: number;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      {subtitle && <p className="mb-3 text-xs text-slate-500">{subtitle}</p>}

      {data.length === 0 ? (
        <div className="flex h-52 items-center justify-center text-sm text-slate-400">
          Not enough data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
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
              width={32}
              tickFormatter={(v: number) => `${v}d`}
            />
            <Tooltip content={<TooltipContent />} />
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="plainline"
              wrapperStyle={{ fontSize: 12, color: "#52514e" }}
            />
            <Line
              type="monotone"
              dataKey="avg"
              name="Average"
              stroke={AVG_COLOR}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="p85"
              name="P85"
              stroke={P85_COLOR}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
