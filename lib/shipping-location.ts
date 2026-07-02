/**
 * Location resolution for the Shipping Performance feature.
 *
 * ParcelPanel webhooks carry `payload.location.name` (the WMS/warehouse label
 * configured in ParcelPanel), which is the primary signal for whether a
 * shipment belongs to Lansil China or Lansil USA. Carrier code is a fallback
 * for the rare payload that omits location name.
 *
 * IMPORTANT: Verify LOCATION_NAME_MAP matches actual location.name values in
 * live ParcelPanel webhooks before considering the feature complete — log the
 * first ~20 webhook payloads (see app/api/webhooks/parcelpanel/route.ts) and
 * confirm payload.location.name against the strings below. Add alternative
 * spellings here if they don't match.
 */

export type ShippingLocationKey = "cn" | "us";

export const LOCATION_NAME_MAP: Record<string, ShippingLocationKey> = {
  "Lansil China": "cn",
  "Lansil USA": "us",
  // Add alternative spellings here after checking live webhook data.
};

export const CARRIER_LOCATION_MAP: Record<string, ShippingLocationKey> = {
  yunexpress: "cn",
  "4px": "cn",
  yanwen: "cn",
  cainiao: "cn",
  "cn-direct": "cn",
  epacket: "cn",
  usps: "us",
  fedex: "us",
  ups: "us",
  "dhl-ecommerce": "us",
  sendle: "us",
};

export function resolveLocation(
  locationName: string | null | undefined,
  carrierCode: string,
): ShippingLocationKey | "unknown" {
  if (locationName) {
    const mapped = LOCATION_NAME_MAP[locationName.trim()];
    if (mapped) return mapped;
  }
  const byCarrier = CARRIER_LOCATION_MAP[carrierCode.toLowerCase()];
  if (byCarrier) return byCarrier;
  console.warn(
    `[shipping] Unknown location: "${locationName}", carrier: "${carrierCode}"`,
  );
  return "unknown";
}

export const DELIVERY_SLA_DAYS: Record<ShippingLocationKey, number> = {
  cn: 14,
  us: 7,
};

export const LOCATION_LABELS: Record<ShippingLocationKey, string> = {
  cn: "Lansil China",
  us: "Lansil USA",
};
