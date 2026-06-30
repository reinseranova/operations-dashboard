import type { DailySummary } from "@/lib/types";

const HOLD_LABELS: Record<keyof DailySummary["ordersOnHold"]["breakdown"], string> =
  {
    fraud_hold: "Fraud",
    address_hold: "Address",
    shipping_method_hold: "Shipping method",
    operator_hold: "Operator",
    payment_hold: "Payment",
    client_hold: "Client",
  };

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
  const holds = summary.ordersOnHold.breakdown;
  const activeHolds = (
    Object.keys(holds) as Array<keyof typeof holds>
  ).filter((k) => holds[k] > 0);

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
        label="Orders on hold"
        value={fmt(summary.ordersOnHold.total)}
        sub={
          activeHolds.length === 0 ? (
            "No active holds"
          ) : (
            <span className="flex flex-wrap gap-x-2 gap-y-0.5">
              {activeHolds.map((k) => (
                <span key={k} className="whitespace-nowrap">
                  {HOLD_LABELS[k]} {holds[k]}
                </span>
              ))}
            </span>
          )
        }
      />
      <Stat
        label="Returns today"
        value={fmt(summary.returnsToday)}
        sub="Received = processed"
      />
      <Stat label="New receivals today" value={fmt(summary.newReceivalsToday)} />
    </section>
  );
}
