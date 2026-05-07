import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { syncCIN7LasVegasTransferOrders, CIN7_TRANSFER_ASSUMPTIONS } from '../../../lib/cin7-transfer-sync';

export const config = { maxDuration: 300 };

function parseCsv(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function getQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Manual trigger endpoint for the CIN7 → ShipHero sync. Accepts override params for
 * modifiedSince, allowedStatuses, maxPages, etc. Used for debugging and backfills.
 *
 * POST /api/cin7/transfers/sync-las-vegas
 * Body: { modifiedSince?, status?, maxPages?, lasVegasAliases?, shipHeroWarehouseId? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
  }

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: 'Server configuration error: Missing Supabase credentials' });
  }

  if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) {
    return res.status(500).json({ success: false, error: 'Server configuration error: Missing CIN7 credentials' });
  }

  const body = (req.body || {}) as Record<string, any>;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const modifiedSince = body.modifiedSince || getQueryValue(req.query.modifiedSince);
  const status = body.status || getQueryValue(req.query.status);
  const shipHeroWarehouseId = body.shipHeroWarehouseId || getQueryValue(req.query.shipHeroWarehouseId);
  const limitRaw = body.limit ?? getQueryValue(req.query.limit);
  const maxPagesRaw = body.maxPages ?? getQueryValue(req.query.maxPages);
  const allowedStatuses = body.allowedStatuses || parseCsv(getQueryValue(req.query.allowedStatuses));
  const lasVegasAliases = body.lasVegasAliases || parseCsv(getQueryValue(req.query.aliases));

  const limit = limitRaw ? Number(limitRaw) : undefined;
  const maxPages = maxPagesRaw ? Number(maxPagesRaw) : undefined;

  console.log('[cin7/transfers/sync-las-vegas] Manual sync:', {
    modifiedSince, status, limit, maxPages,
  });

  try {
    const result = await syncCIN7LasVegasTransferOrders(supabase, {
      modifiedSince,
      status,
      shipHeroWarehouseId,
      limit,
      maxPages,
      allowedStatuses,
      lasVegasAliases,
    });

    return res.status(result.success ? 200 : 500).json({
      mode: 'manual',
      ...result,
      assumptions: {
        endpoint: CIN7_TRANSFER_ASSUMPTIONS.endpoint,
        defaultEligibleStatuses: CIN7_TRANSFER_ASSUMPTIONS.defaultEligibleStatuses,
        lasVegasAliases: CIN7_TRANSFER_ASSUMPTIONS.lasVegasAliases,
      },
    });
  } catch (error) {
    console.error('[cin7/transfers/sync-las-vegas] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
