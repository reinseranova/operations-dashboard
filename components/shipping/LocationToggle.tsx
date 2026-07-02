"use client";

import { LOCATION_LABELS, type ShippingLocationKey } from "@/lib/shipping-location";

const LOCATIONS: ShippingLocationKey[] = ["cn", "us"];

export function LocationToggle({
  value,
  onChange,
}: {
  value: ShippingLocationKey;
  onChange: (loc: ShippingLocationKey) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm">
      {LOCATIONS.map((loc) => (
        <button
          key={loc}
          type="button"
          onClick={() => onChange(loc)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === loc
              ? "bg-slate-900 text-white"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {LOCATION_LABELS[loc]}
        </button>
      ))}
    </div>
  );
}

export function PillGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            value === opt.value
              ? "bg-slate-900 text-white"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
