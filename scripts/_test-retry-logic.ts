/**
 * Behavioural test for the SP-API 429 retry layer.
 * Run: npx tsx scripts/_test-retry-logic.ts
 */
import { callAmazonSpApi, SpApiError, _clearTokenCacheForTests } from '../lib/amazon-sp-api-client';

const origFetch = globalThis.fetch;
let calls: string[] = [];

function mockFetch(sequence: Array<{ status: number; body?: any; retryAfter?: string }>) {
  let i = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    // LWA token endpoint
    if (u.includes('api.amazon.com/auth/o2/token')) {
      return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
    }
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    calls.push(`${step.status}`);
    const headers: Record<string, string> = {};
    if (step.retryAfter) headers['retry-after'] = step.retryAfter;
    return new Response(JSON.stringify(step.body ?? { ok: step.status < 300 }), {
      status: step.status,
      headers,
    });
  }) as any;
}

async function run(name: string, fn: () => Promise<void>) {
  calls = [];
  _clearTokenCacheForTests();
  process.env.AMAZON_CLIENT_ID ||= 'x';
  process.env.AMAZON_CLIENT_SECRET ||= 'x';
  process.env.AMAZON_REFRESH_TOKEN ||= 'x';
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name}  (${Date.now() - t0}ms, upstream calls: ${calls.join(',')})`);
  } catch (e: any) {
    console.log(`FAIL  ${name}: ${e?.message}  (upstream calls: ${calls.join(',')})`);
    process.exitCode = 1;
  }
}

(async () => {
  // 1. 429 then success -> should retry and succeed
  await run('429 then 200 retries and succeeds', async () => {
    mockFetch([{ status: 429 }, { status: 200, body: { good: true } }]);
    const r = await callAmazonSpApi({ method: 'GET', path: '/x' });
    if ((r.data as any).good !== true) throw new Error('did not get success payload');
    if (calls.length !== 2) throw new Error(`expected 2 upstream calls, got ${calls.length}`);
  });

  // 2. Retry-After honoured (1s) -> elapsed should be >=1000ms
  await run('honours Retry-After header', async () => {
    mockFetch([{ status: 429, retryAfter: '1' }, { status: 200 }]);
    const t = Date.now();
    await callAmazonSpApi({ method: 'GET', path: '/x' });
    const el = Date.now() - t;
    if (el < 950) throw new Error(`did not wait for Retry-After (waited ${el}ms)`);
  });

  // 3. 400 -> must NOT retry (fail fast, no masking real errors)
  await run('400 fails fast without retry', async () => {
    mockFetch([{ status: 400, body: { errors: [{ code: 'Bad' }] } }]);
    try {
      await callAmazonSpApi({ method: 'GET', path: '/x' });
      throw new Error('should have thrown');
    } catch (e: any) {
      if (!(e instanceof SpApiError) || e.status !== 400) throw new Error('wrong error: ' + e?.message);
      if (calls.length !== 1) throw new Error(`400 was retried ${calls.length} times`);
    }
  });

  // 4. persistent 429 -> exhausts retries and throws 429 (not a generic error)
  await run('persistent 429 exhausts and throws 429', async () => {
    mockFetch([{ status: 429, retryAfter: '0' }]);
    try {
      await callAmazonSpApi({ method: 'GET', path: '/x' });
      throw new Error('should have thrown');
    } catch (e: any) {
      if (!(e instanceof SpApiError) || e.status !== 429) throw new Error('wrong error: ' + e?.message);
      if (calls.length !== 6) throw new Error(`expected 6 attempts (1+5 retries), got ${calls.length}`);
    }
  });

  // 5. 503 retried too
  await run('503 retries then succeeds', async () => {
    mockFetch([{ status: 503, retryAfter: '0' }, { status: 200 }]);
    await callAmazonSpApi({ method: 'GET', path: '/x' });
    if (calls.length !== 2) throw new Error(`expected 2 calls, got ${calls.length}`);
  });

  globalThis.fetch = origFetch;
})();
