function fmtDays(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}d`;
}

function fmtCount(n: number): string {
  return `${n.toLocaleString("en-US")} orders`;
}

export function ShippingKpiCard({
  label,
  avg,
  p85,
  count,
  trendDays,
}: {
  label: string;
  avg: number | null;
  p85: number | null;
  count: number;
  /** current-period avg − prior-period avg, in days. Positive = slower. */
  trendDays: number | null;
}) {
  const hasP85 = count >= 20 && p85 !== null;
  const trendUp = trendDays !== null && trendDays > 0.05;
  const trendDown = trendDays !== null && trendDays < -0.05;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {fmtDays(avg)}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        P85: {hasP85 ? fmtDays(p85) : "—"}
      </div>
      <div className="mt-2 flex items-center justify-between">
        {trendDays === null ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${
              trendUp ? "text-red-600" : trendDown ? "text-emerald-600" : "text-slate-400"
            }`}
          >
            {trendUp ? "↑" : trendDown ? "↓" : "→"} {Math.abs(trendDays).toFixed(1)}d vs prev
            period
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-400">{fmtCount(count)}</div>
    </div>
  );
}
