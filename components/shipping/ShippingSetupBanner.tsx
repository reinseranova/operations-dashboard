import type { ShippingLocationKey } from "@/lib/shipping-location";
import { LOCATION_LABELS } from "@/lib/shipping-location";

export function ShippingSetupBanner({ loc }: { loc: ShippingLocationKey }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">
        📦 No shipping data yet for {LOCATION_LABELS[loc]}
      </h3>
      <p className="mt-1 text-sm text-slate-500">To get started:</p>

      <ol className="mt-4 space-y-4 text-sm text-slate-700">
        <li>
          <span className="font-medium text-slate-900">1. Add PARCELPANEL_API_KEY</span> to your
          Vercel environment variables (ParcelPanel Dashboard → Integration → API Keys).
        </li>
        <li>
          <span className="font-medium text-slate-900">2. Register the webhook</span> in
          ParcelPanel Dashboard → Integration → Webhooks:
          <div className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-600">
            <div>URL: https://[your-domain]/api/webhooks/parcelpanel</div>
            <div>Events: shipment_status/any_update</div>
          </div>
        </li>
        <li>
          <span className="font-medium text-slate-900">3. Register the ShipHero Shipment Update webhook</span>{" "}
          (for USA pickup precision):
          <div className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-600">
            <div>URL: https://[your-domain]/api/webhooks/shiphero-shipment</div>
            <div>Header: x-refresh-secret: [REFRESH_SECRET]</div>
          </div>
        </li>
        <li>
          <span className="font-medium text-slate-900">4. Once webhooks are registered, run the historical data seed:</span>
          <div className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-600">
            <div>POST /api/shipping-bootstrap</div>
            <div>Header: Authorization: Bearer [REFRESH_SECRET]</div>
          </div>
          <p className="mt-1 text-slate-500">
            This seeds 30 days of processing time from Shopify immediately. Transit and pickup
            time build over the next 2–4 weeks from live webhooks.
          </p>
        </li>
      </ol>
    </div>
  );
}
