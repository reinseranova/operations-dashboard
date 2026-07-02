"use client";

import { useState } from "react";
import type { SkuRow } from "@/lib/types";

const fmt = (n: number) => n.toLocaleString("en-US");

function DaysOfStock({ row }: { row: SkuRow }) {
  if (row.daysOfStock === null) {
    return (
      <span className="text-slate-400" title="No recent sales in the last 30 days">
        —
      </span>
    );
  }
  const days = row.daysOfStock;
  const color =
    days < 14
      ? "text-red-600"
      : days < 30
        ? "text-amber-600"
        : "text-emerald-600";
  return (
    <span className={`font-semibold tabular-nums ${color}`}>
      {days < 10 ? days.toFixed(1) : Math.round(days)}
      <span className="ml-1 text-xs font-normal text-slate-400">days</span>
    </span>
  );
}

function LotDetail({ row }: { row: SkuRow }) {
  if (row.lots.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-slate-500">
        No lot detail reported for this SKU.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-1 pr-4 font-medium">Warehouse</th>
            <th className="py-1 pr-4 font-medium">Lot #</th>
            <th className="py-1 pr-4 font-medium">Qty</th>
            <th className="py-1 pr-4 font-medium">Expiration</th>
          </tr>
        </thead>
        <tbody>
          {row.lots.map((lot, i) => (
            <tr key={`${lot.lotNumber ?? "no-lot"}-${lot.warehouseKey}-${i}`} className="border-t border-slate-100">
              <td className="py-1.5 pr-4 uppercase text-slate-600">
                {lot.warehouseKey}
              </td>
              <td className="py-1.5 pr-4 font-mono text-slate-800">
                {lot.lotNumber ?? <span className="text-slate-400">no lot</span>}
              </td>
              <td className="py-1.5 pr-4 tabular-nums text-slate-800">
                {fmt(lot.quantity)}
              </td>
              <td className="py-1.5 pr-4 text-slate-600">
                {lot.expirationDate ?? (
                  <span className="text-slate-400">none</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkuTable({ skus }: { skus: SkuRow[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (sku: string) =>
    setExpanded((e) => ({ ...e, [sku]: !e[sku] }));

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="hidden grid-cols-12 gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate-500 md:grid">
        <div className="col-span-4">SKU</div>
        <div className="col-span-1 text-right">NV</div>
        <div className="col-span-1 text-right">PA</div>
        <div className="col-span-2 text-right">Total stock</div>
        <div className="col-span-2 text-right">30d sold</div>
        <div className="col-span-2 text-right">Days of stock</div>
      </div>

      <ul className="divide-y divide-slate-100">
        {skus.map((row) => {
          const isOpen = !!expanded[row.sku];
          return (
            <li key={row.sku}>
              <button
                type="button"
                onClick={() => toggle(row.sku)}
                className="grid w-full grid-cols-2 items-center gap-2 px-4 py-3 text-left transition hover:bg-slate-50 md:grid-cols-12"
              >
                <div className="col-span-2 md:col-span-4">
                  <div className="flex items-center gap-2">
                    <svg
                      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <div>
                      <div className="font-mono text-sm font-medium text-slate-900">
                        {row.sku}
                      </div>
                      {row.productName && (
                        <div className="text-xs text-slate-500">
                          {row.productName}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hidden text-right tabular-nums text-slate-700 md:col-span-1 md:block">
                  {fmt(row.stock.nv)}
                </div>
                <div className="hidden text-right tabular-nums text-slate-700 md:col-span-1 md:block">
                  {fmt(row.stock.pa)}
                </div>
                <div className="col-span-2 text-right font-semibold tabular-nums text-slate-900 md:col-span-2">
                  {fmt(row.stock.total)}
                  <span className="ml-2 text-xs font-normal text-slate-400 md:hidden">
                    (NV {fmt(row.stock.nv)} / PA {fmt(row.stock.pa)})
                  </span>
                </div>
                <div className="hidden text-right tabular-nums text-slate-700 md:col-span-2 md:block">
                  {row.units30 === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    fmt(row.units30)
                  )}
                </div>
                <div className="col-span-2 text-right md:col-span-2">
                  <DaysOfStock row={row} />
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50/50">
                  <LotDetail row={row} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
