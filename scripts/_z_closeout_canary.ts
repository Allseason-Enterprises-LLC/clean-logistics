import { createClient } from '@supabase/supabase-js';
import { runCin7Closeout } from '../lib/cin7-closeout';
import { getShipHeroToken } from '../lib/shiphero-product-data';
import { executeCIN7Request, newCin7Meter } from '../lib/cin7-transfer-sync';
(async () => {
  const url = process.env.SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const tok = await getShipHeroToken(url, key, '22e17170-af72-4bf8-b77c-d73c86b06765');
  const only = process.argv[2];
  if (!only) throw new Error('canary requires a TR');
  const { data: row } = await db.from('cin7_transfer_shiphero_orders').select('cin7_transfer_id').eq('cin7_transfer_number', only).single();
  const before: any = await executeCIN7Request('/stockTransfer', { TaskID: row!.cin7_transfer_id }, { meter: newCin7Meter(), maxRetries: 2 });
  console.log('BEFORE', only, before.Status, before.CompletionDate, (before.Order?.Lines ?? []).map((l: any) => [l.SKU, l.TransferQuantity, l.BatchSN, l.ExpiryDate]));
  const r = await runCin7Closeout(db, tok, { only, limit: 1, notify: async (m) => console.log('[notify]', m) });
  console.log('RESULT', JSON.stringify({ completed: r.completed, held: r.held, waiting: r.waiting, errors: r.errors, calls: r.cin7Calls }));
  await new Promise((res) => setTimeout(res, 3000));
  const after: any = await executeCIN7Request('/stockTransfer', { TaskID: row!.cin7_transfer_id }, { meter: newCin7Meter(), maxRetries: 2 });
  console.log('AFTER ', only, after.Status, after.CompletionDate, (after.Order?.Lines ?? []).map((l: any) => [l.SKU, l.TransferQuantity, l.BatchSN, l.ExpiryDate]), '| Order.Status', after.Order?.Status);
})();
