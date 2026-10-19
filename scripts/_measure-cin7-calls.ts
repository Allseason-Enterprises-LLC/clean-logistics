/**
 * DRY-RUN measurement of CIN7 HTTP calls per syncCIN7LasVegasTransferOrders run.
 * Runs the REAL sync code with globalThis.fetch mocked (no network) and an
 * in-memory Supabase fake whose bridge rows are all already `synced` (so no
 * ShipHero / Amazon / Telegram path is reached — and none of those paths call
 * CIN7 anyway: dearsystems is only referenced from lib/cin7*.ts).
 * Counts every request to inventory.dearsystems.com, retries included.
 * Run: npx tsx scripts/_measure-cin7-calls.ts
 */
process.env.CIN7_ACCOUNT_ID ||= 'acct-test';
process.env.CIN7_API_KEY ||= 'key-test';

type Scenario = { name: string; total: number; lv: number; detail429First?: boolean; detailOkPath?: string };

function makeTransfers(total: number, lv: number) {
  return Array.from({ length: total }, (_, i) => ({
    TaskID: `task-${i}`,
    Number: `TR-${String(90000 + i)}`,
    Status: 'AUTHORISED',
    FromLocation: i < lv ? 'Clean Nutra ASE Warehouse - Vegas' : 'Intermountain',
    ToLocation: i < lv ? 'Amazon FBA Warehouse' : 'Somewhere Else',
  }));
}

function fakeSupabase() {
  const builder = (table: string): any => {
    const b: any = {
      select: () => b, eq: () => b, limit: () => b, update: () => b, upsert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: table === 'cin7_transfer_shiphero_orders'
        ? { shiphero_order_id: 'so-1', shiphero_order_number: 'AMZ_X', status: 'synced', synced_at: 'x', request_payload: { type: 'order' } }
        : null, error: null }),
      single: async () => ({ data: null, error: { message: 'n/a' } }),
      then: (res: any) => res({ data: table === 'warehouses'
        ? [{ id: '22e17170-af72-4bf8-b77c-d73c86b06765', name: 'Clean Nutra LV', api_credentials: { accessToken: 't' } }]
        : [], error: null }),
    };
    return b;
  };
  return { from: builder } as any;
}

async function run(s: Scenario) {
  const transfers = makeTransfers(s.total, s.lv);
  const calls: string[] = [];
  let other = 0;
  const seen429 = new Set<string>();
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    // Downstream (ShipHero/Supabase/Telegram/self) is stubbed to fail; none of it calls CIN7.
    if (!u.host.includes('dearsystems')) { other++; return new Response('stubbed', { status: 503 }); }
    const path = u.pathname.replace('/ExternalApi/v2', '');
    calls.push(path);
    if (path === '/stockTransferList') {
      const page = Number(u.searchParams.get('Page')); const lim = Number(u.searchParams.get('Limit'));
      const body = { Total: transfers.length, Page: page, StockTransferList: transfers.slice((page - 1) * lim, page * lim) };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const task = u.searchParams.get('TaskID')!;
    if (s.detail429First && !seen429.has(task)) {
      seen429.add(task);
      return new Response('You have reached 60 calls per 60 seconds API limit.', { status: 429, headers: { 'Retry-After': '60 Seconds' } });
    }
    if (s.detailOkPath && path !== s.detailOkPath) return new Response('Not Found', { status: 404 });
    return new Response(JSON.stringify({ TaskID: task, Status: 'AUTHORISED', Lines: [{ SKU: 'CN-X', Quantity: 10 }] }), { status: 200 });
  }) as any;

  // Silence the very chatty sync logs and fake the clock for any waits.
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.log = console.warn = console.error = () => {};
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: any) => realSetTimeout(fn, 0);
  const mod = await import('../lib/cin7-transfer-sync');
  (mod as any).__resetCin7DetailPathCache?.();
  let result: any;
  try {
    result = await mod.syncCIN7LasVegasTransferOrders(fakeSupabase(), { modifiedSince: new Date().toISOString(), maxPages: 10 });
  } finally {
    console.log = origLog; console.warn = origWarn; console.error = origErr;
    (globalThis as any).setTimeout = realSetTimeout;
  }
  const list = calls.filter((c) => c === '/stockTransferList').length;
  console.log(
    `${s.name.padEnd(58)} counted=${String(calls.length).padStart(3)}  list=${list}  detail=${calls.length - list}` +
      `  result.cin7_calls=${result.cin7_calls ?? 'n/a'}  rate_limited=${result.cin7_rate_limited ?? 'n/a'}` +
      `  wait_s=${(result.cin7_wait_ms ?? 0) / 1000}  non_cin7_stubbed=${other}`
  );
  return calls.length;
}

async function main() {
  const out: Record<string, number> = {};
  for (const s of [
    { name: 'A: quiet tick (0 transfers in window)', total: 0, lv: 0 },
    { name: 'B: 1 LV->FBA transfer', total: 1, lv: 1 },
    { name: 'C: 5 LV->FBA transfers', total: 5, lv: 5 },
    { name: 'D: 150 in window (2 pages), 12 LV', total: 150, lv: 12 },
    { name: 'E: 5 LV, every detail gets one 429 first', total: 5, lv: 5, detail429First: true },
    { name: 'F: 5 LV, only /StockTransfer casing answers', total: 5, lv: 5, detailOkPath: '/StockTransfer' },
  ] as Scenario[]) out[s.name] = await run(s);
}
main();
