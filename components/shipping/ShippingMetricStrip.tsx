import type { ShippingSummary } from "@/lib/shipping-metrics";

function fmtPct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function Metric({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700">
      {children}
    </div>
  );
}

export function ShippingMetricStrip({ summary }: { summary: ShippingSummary }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Metric>
        <span className="font-semibold text-slate-900">
          Exceptions: {fmtPct(summary.exceptionRate)}
        </span>{" "}
        <span className="text-slate-500">
          ({summary.exceptionCount.toLocaleString("en-US")} orders)
        </span>
      </Metric>
      <Metric>
        <span className="font-semibold text-slate-900">On-time: {fmtPct(summary.onTimeRate)}</span>{" "}
        <span className="text-slate-500">(within {summary.slaDays}d SLA)</span>
      </Metric>
      <Metric>
        <span className="font-semibold text-slate-900">
          Failed deliveries: {fmtPct(summary.failedAttemptRate)}
        </span>
      </Metric>
    </div>
  );
}
