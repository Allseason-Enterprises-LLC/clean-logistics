/**
 * Channel classification for ShipHero orders.
 *
 * Single source of truth — used by both the realtime cron auto-tagger and
 * the one-shot backfill script.
 *
 * Returns a list of tags to add. Returns skip=true for internal orders
 * we don't want channel-tagged (CIN7 transfers, influencer samples, tests).
 */

export interface OrderForClassification {
  order_number: string;
  partner_order_id: string | null;
  shop_name: string | null;
  source: string | null;
  partner_source_name: string | null;
  tags: string[];
}

export interface ClassificationResult {
  tags: string[];
  skip: boolean;
  reason: string;
}

export function classifyOrderChannel(order: OrderForClassification): ClassificationResult {
  const shop = (order.shop_name || '').toLowerCase();
  const source = (order.source || '').toLowerCase();
  const tags = (order.tags || []).map(t => t.toLowerCase());
  const orderNum = order.order_number || '';

  // ---- Internal / non-customer orders: skip ----
  if (tags.includes('cin7-transfer')) {
    return { tags: [], skip: true, reason: 'CIN7 transfer (internal)' };
  }
  if (tags.includes('influencer-sample')) {
    return { tags: [], skip: true, reason: 'Influencer sample (internal)' };
  }
  if (tags.includes('test-order')) {
    return { tags: [], skip: true, reason: 'Test order' };
  }
  if (tags.includes('replacement-order') || tags.includes('cs man order') || /^CSR-/i.test(orderNum)) {
    return { tags: [], skip: true, reason: 'Customer service replacement (internal)' };
  }
  if (shop === 'public-api') {
    return { tags: [], skip: true, reason: 'public-api (internal)' };
  }

  // ---- TikTok ----
  // FBT first (mutually exclusive with TikTok pickable)
  if (tags.includes('fulfilled_by_tiktok')) {
    return { tags: ['TikTok-FBT'], skip: false, reason: 'fulfilled_by_tiktok tag' };
  }
  // Native TikTok integration
  if (source === 'tiktok') {
    return { tags: ['TikTok'], skip: false, reason: 'source=tiktok' };
  }
  // Bridge legacy
  if (shop === 'tiktok shop') {
    return { tags: ['TikTok'], skip: false, reason: 'shop_name=TikTok Shop (bridge legacy)' };
  }
  if (tags.some(t => t.startsWith('tiktok_'))) {
    return { tags: ['TikTok'], skip: false, reason: 'tiktok_* tag (no FBT)' };
  }

  // ---- Amazon ----
  if (source === 'amazon') {
    return { tags: ['Amazon'], skip: false, reason: 'source=amazon' };
  }
  if (shop.includes('amazon') || /^\d{3}-\d{7}-\d{7}$/.test(orderNum)) {
    return { tags: ['Amazon'], skip: false, reason: 'amazon order_number pattern or shop_name' };
  }

  // ---- Walmart (speculative — verify on first real order) ----
  if (source === 'walmart' || shop.includes('walmart')) {
    return { tags: ['Walmart'], skip: false, reason: 'source/shop=walmart' };
  }

  // ---- Website: Shopify ----
  if (source === 'shopify' || shop.includes('myshopify.com')) {
    return { tags: ['Website', 'Website-Shopify'], skip: false, reason: 'source=shopify or myshopify shop_name' };
  }

  // ---- Website: Checkout Champ ----
  if (shop === 'checkoutchamp') {
    return { tags: ['Website', 'Website-CC'], skip: false, reason: 'shop_name=CheckoutChamp' };
  }
  // CC orders pushed via API have either:
  //   - order_number prefixed with "CC-"
  //   - or a 5-7 digit numeric partner_order_id with shop=Clean Nutra + source=api
  if (/^CC-/i.test(orderNum)) {
    return { tags: ['Website', 'Website-CC'], skip: false, reason: 'CC- prefix order_number' };
  }
  if (
    shop === 'clean nutra' &&
    source === 'api' &&
    order.partner_order_id &&
    /^\d{5,7}$/.test(order.partner_order_id)
  ) {
    return { tags: ['Website', 'Website-CC'], skip: false, reason: 'CC pattern (Clean Nutra/api/numeric partner_id)' };
  }

  // ---- Manual orders: leave untagged ----
  if (shop === 'manual order') {
    return { tags: [], skip: true, reason: 'Manual order' };
  }

  // ---- Unclassified ----
  return { tags: [], skip: true, reason: `Unclassified (shop=${order.shop_name}, source=${order.source})` };
}
