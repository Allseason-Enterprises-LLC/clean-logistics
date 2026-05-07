import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { syncCIN7LasVegasTransferOrders, CIN7_TRANSFER_ASSUMPTIONS } from '../../lib/cin7-transfer-sync';

export const config = { maxDuration: 300 };

function getQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Vercel cron handler: polls CIN7 for Las Vegas stock transfers and routes them to
 * ShipHero.
 *
 *   - Inbound (manufacturer/3PL → LV)  → create ShipHero Purchase Order
 *   - Outbound (LV → Amazon FBA)       → create ShipHero Order + fire FBA auto-submit
 *
 * Bound to Vercel cron schedule in vercel.json at /api/cron/sync-cin7-las-vegas-transfers.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: Missing Supabase credentials',
    });
  }

  if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: Missing CIN7 credentials (CIN7_ACCOUNT_ID or CIN7_API_KEY)',
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Default look-back window: 20 min (matches the cron interval)
  const modifiedSince = getQueryValue(req.query.modifiedSince)
    || new Date(Date.now() - 1000 * 60 * 20).toISOString();
  const shipHeroWarehouseId = getQueryValue(req.query.shipHeroWarehouseId);
  const status = getQueryValue(req.query.status);

  console.log('[cron/sync-cin7-las-vegas-transfers] Starting sync...', {
    modifiedSince,
    status,
    shipHeroWarehouseId,
  });

  try {
    const result = await syncCIN7LasVegasTransferOrders(supabase, {
      modifiedSince,
      status,
      shipHeroWarehouseId,
      maxPages: 10,
    });

    console.log('[cron/sync-cin7-las-vegas-transfers] Complete:', {
      success: result.success,
      fetched: result.fetched,
      filteredLasVegas: result.filteredLasVegas,
      eligible: result.eligible,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors.length,
    });

    return res.status(result.success ? 200 : 500).json({
      mode: 'cron',
      ...result,
      assumptions: {
        endpoint: CIN7_TRANSFER_ASSUMPTIONS.endpoint,
        defaultEligibleStatuses: CIN7_TRANSFER_ASSUMPTIONS.defaultEligibleStatuses,
      },
    });
  } catch (error) {
    console.error('[cron/sync-cin7-las-vegas-transfers] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
