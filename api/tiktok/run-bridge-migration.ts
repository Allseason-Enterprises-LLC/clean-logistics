/**
 * POST /api/tiktok/run-bridge-migration
 *
 * One-shot endpoint to apply the tiktok_shiphero_orders bridge table migration.
 * Runs the SQL file at supabase/migrations/20260504_tiktok_shiphero_bridge.sql
 * against Supabase using the service role. Idempotent.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase';
import fs from 'fs';
import path from 'path';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require INTERNAL_API_KEY to avoid accidental public invocation
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(500).json({ error: 'INTERNAL_API_KEY not set' });
  }
  if (apiKey !== expected && apiKey !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sqlPath = path.join(
      process.cwd(),
      'supabase/migrations/20260504_tiktok_shiphero_bridge.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Use the `exec_sql` RPC if available, else fall back to raw pg via PostgREST.
    // Supabase doesn't ship an exec_sql by default, so split and run each statement
    // via the admin REST endpoint. Easiest: use the `pg-meta` style.
    //
    // In practice, clean-logistics already has a `run-migration.ts` that uses the
    // supabase admin REST call below. We replicate that pattern.
    const { error } = await supabase.rpc('exec_sql', { sql });

    if (error) {
      // Fallback: split and execute via PostgREST isn't possible without exec_sql.
      return res.status(500).json({
        error:
          `Supabase RPC exec_sql failed: ${error.message}. Apply the migration manually via the Supabase SQL Editor:\n\n${sql}`,
      });
    }

    return res.status(200).json({ success: true, message: 'Migration applied' });
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
