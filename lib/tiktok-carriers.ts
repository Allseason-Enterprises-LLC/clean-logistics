/**
 * Carrier name mapping — ShipHero → TikTok.
 *
 * ShipHero returns carrier strings like "UPS", "USPS GROUND", "FedEx Ground Economy".
 * TikTok requires a `shipping_provider_id` that maps to their shop-specific list
 * (pulled via getShippingProviders() in tiktok-api.ts).
 *
 * This module normalizes the ShipHero carrier string to a canonical key,
 * then resolves that key to a TikTok provider ID by fuzzy-matching names.
 */

export type CanonicalCarrier =
  | 'ups'
  | 'usps'
  | 'fedex'
  | 'dhl'
  | 'ontrac'
  | 'lasership'
  | 'amazon'
  | 'unknown';

/**
 * Normalize a ShipHero carrier string to one of our canonical keys.
 */
export function normalizeCarrier(shipheroCarrier: string | null | undefined): CanonicalCarrier {
  if (!shipheroCarrier) return 'unknown';
  const s = shipheroCarrier.toLowerCase();

  if (s.includes('ups')) return 'ups';
  if (s.includes('usps') || s.includes('postal')) return 'usps';
  if (s.includes('fedex')) return 'fedex';
  if (s.includes('dhl')) return 'dhl';
  if (s.includes('ontrac')) return 'ontrac';
  if (s.includes('lasership')) return 'lasership';
  if (s.includes('amazon')) return 'amazon';
  return 'unknown';
}

/**
 * Friendly display name for the canonical carrier key.
 * Used as the first-pass fuzzy match against TikTok's provider list.
 */
const CARRIER_DISPLAY: Record<CanonicalCarrier, string[]> = {
  ups: ['UPS'],
  usps: ['USPS', 'United States Postal Service'],
  fedex: ['FedEx'],
  dhl: ['DHL'],
  ontrac: ['OnTrac'],
  lasership: ['LaserShip'],
  amazon: ['Amazon'],
  unknown: ['Other'],
};

/**
 * Given TikTok's shop-specific provider list, find the ID that matches our canonical key.
 * Returns null if nothing matches (caller should log + fall back to 'Other').
 */
export function resolveProviderId(
  canonical: CanonicalCarrier,
  providers: Array<{ id: string; name: string }>
): string | null {
  const candidates = CARRIER_DISPLAY[canonical];

  for (const candidate of candidates) {
    const match = providers.find((p) =>
      p.name.toLowerCase().includes(candidate.toLowerCase())
    );
    if (match) return match.id;
  }
  return null;
}

/**
 * Fallback TikTok shipping_provider_id map for the Clean Nutra shop.
 *
 * These IDs were extracted from already-shipped packages on the Clean Nutra
 * TikTok shop (shop_id 7495291933339519508) — e.g. USPS appears as
 * `7117858858072016686` on successful IN_TRANSIT packages.
 *
 * We keep this hardcoded because our TikTok app doesn't currently have the
 * `logistics` API scope — `/logistics/202309/shipping_providers` returns
 * `no schema found`. Without these IDs, `postTrackingToTikTok` throws and
 * the webhook retries forever.
 *
 * If TikTok ever changes these, add a new entry and update the fallback.
 */
export const CLEAN_NUTRA_PROVIDER_IDS: Record<CanonicalCarrier, string | null> = {
  // Only USPS is verified (extracted from IN_TRANSIT package 1156298521127194932).
  // Add other carriers here as they're observed on successful packages in this shop.
  usps: '7117858858072016686',
  ups: null,
  fedex: null,
  dhl: null,
  ontrac: null,
  lasership: null,
  amazon: null,
  unknown: null,
};

/**
 * Resolve a TikTok shipping_provider_id for a canonical carrier, preferring
 * the live provider list but falling back to the hardcoded shop-specific map
 * when the list isn't available (missing app scope).
 */
export function resolveProviderIdWithFallback(
  canonical: CanonicalCarrier,
  providers: Array<{ id: string; name: string }>
): string | null {
  const fromLive = resolveProviderId(canonical, providers);
  if (fromLive) return fromLive;
  return CLEAN_NUTRA_PROVIDER_IDS[canonical] || null;
}
