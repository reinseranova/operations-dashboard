import type { DailySummary } from "@/lib/types";

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function SummaryStrip({ summary }: { summary: DailySummary }) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="Orders fulfilled today"
        value={fmt(summary.ordersFulfilledToday)}
      />
      <Stat
        label="Orders created today"
        value={
          summary.ordersCreatedTodayShopify === null
            ? "—"
            : fmt(summary.ordersCreatedTodayShopify)
        }
        sub="Shopify"
      />
      <Stat
        label="Returns today"
        value={fmt(summary.returnsToday)}
        sub="Return records received"
      />
      <Stat label="New receivals today" value={fmt(summary.newReceivalsToday)} />
    </section>
  );
}
