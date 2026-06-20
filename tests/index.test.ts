import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import worker from '../src/index.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

class MemoryKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, _options?: unknown): Promise<void> {
    this.store.set(key, String(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()]
      .filter(name => name.startsWith(prefix))
      .sort()
      .map(name => ({ name }));
    return { keys };
  }
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const assetsRequests: Request[] = [];
  const env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetsRequests.push(req);
        return new Response('asset fallback', { status: 200 });
      },
    },
    EF_STATE: new MemoryKV(),
    EF_SUBS: new MemoryKV(),
    USER_AGENT: 'EdgarFlash tests@example.com',
    ...overrides,
  };
  return { env, assetsRequests };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://edgarflash.test${path}`, init);
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function filing(id: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    form: '4',
    title: `4 - ${id.toUpperCase()} INC (0000000001) (Filer)`,
    url: `https://www.sec.gov/Archives/${id}`,
    filed_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    ...extra,
  };
}

async function seedFeed(env: any, filings: unknown[]) {
  await env.EF_STATE.put('feed:recent', JSON.stringify(filings));
}

test('serves the delayed, limited public feed and falls back to assets', async () => {
  const { env, assetsRequests } = createEnv();
  const recent = filing('recent', 1);
  const oldFilings = Array.from({ length: 12 }, (_, i) => filing(`old-${i}`, 16 + i));
  await seedFeed(env, [recent, ...oldFilings]);

  const missingRealtimeKey = await worker.fetch(req('/api/realtime'), env as any);
  assert.equal(missingRealtimeKey.status, 401);
  assert.deepEqual(await json(missingRealtimeKey), { error: 'api_key_required' });

  const res = await worker.fetch(req('/api/feed'), env as any);
  assert.equal(res.status, 200);
  const body = await json(res);

  assert.equal(body.tier, 'free');
  assert.equal(body.realtime, false);
  assert.equal(body.delayed_minutes, 15);
  assert.equal(body.limit, 10);
  assert.equal(body.total_cached, 13);
  assert.equal(body.count, 10);
  assert.deepEqual(body.filings.map((f: any) => f.id), oldFilings.slice(0, 10).map(f => f.id));

  const assetRes = await worker.fetch(req('/'), env as any);
  assert.equal(assetRes.status, 200);
  assert.equal(await assetRes.text(), 'asset fallback');
  assert.equal(assetsRequests.length, 1);
});

test('validates and persists free subscriptions without exposing secrets', async () => {
  const { env } = createEnv();

  const badEmail = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-an-email' }),
  }), env as any);
  assert.equal(badEmail.status, 400);
  assert.deepEqual(await json(badEmail), { error: 'valid email required' });

  const badForms = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'person@example.com', forms: ['10-K'] }),
  }), env as any);
  assert.equal(badForms.status, 400);

  const freeWithTickers = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'person@example.com', tickers: ['AAPL'] }),
  }), env as any);
  assert.equal(freeWithTickers.status, 400);
  assert.equal((await json(freeWithTickers)).error, 'free plan allows up to 0 ticker filters');

  const res = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'Person@Example.COM ',
      plan: 'free',
      forms: ['4', '4', '8-K', '10-K'],
    }),
  }), env as any);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.status, 'active');
  assert.equal(body.plan, 'free');

  const subRes = await worker.fetch(req(`/api/subscription/${body.subscription_id}`), env as any);
  assert.equal(subRes.status, 200);
  const sub = await json(subRes);
  assert.equal(sub.id, body.subscription_id);
  assert.equal(sub.plan, 'free');
  assert.equal(sub.active, true);
  assert.equal(sub.realtime_api, false);
  assert.deepEqual(sub.forms, ['4', '8-K']);
  assert.equal('webhook_url' in sub, false);
  assert.equal('api_key_hash' in sub, false);
});

test('rejects malformed subscription input and returns request ids', async () => {
  const { env } = createEnv();

  const invalidJson = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    headers: { 'x-request-id': 'req-test-1' },
    body: '{',
  }), env as any);
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.headers.get('x-request-id'), 'req-test-1');
  assert.deepEqual(await json(invalidJson), { error: 'invalid JSON' });

  const nonObject = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify([]),
  }), env as any);
  assert.equal(nonObject.status, 400);
  assert.deepEqual(await json(nonObject), { error: 'JSON object required' });

  const badPlan = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'person@example.com', plan: 'enterprise' }),
  }), env as any);
  assert.equal(badPlan.status, 400);
  assert.deepEqual(await json(badPlan), { error: 'plan must be one of: free, pro, institutional' });

  const badFormsShape = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'person@example.com', forms: '4' }),
  }), env as any);
  assert.equal(badFormsShape.status, 400);
  assert.deepEqual(await json(badFormsShape), { error: 'forms must be an array of strings' });

  const insecureWebhook = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'person@example.com',
      plan: 'pro',
      webhook_url: 'http://hooks.example/pro',
    }),
  }), env as any);
  assert.equal(insecureWebhook.status, 400);
  assert.deepEqual(await json(insecureWebhook), { error: 'webhook_url must be a valid HTTPS URL' });

  const invalidTicker = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'person@example.com',
      plan: 'pro',
      webhook_url: 'https://hooks.example/pro',
      tickers: ['BAD TICKER'],
    }),
  }), env as any);
  assert.equal(invalidTicker.status, 400);
  assert.deepEqual(await json(invalidTicker), {
    error: 'tickers must be 1-12 characters using letters, numbers, dot, or hyphen',
  });
});

test('runs paid checkout, confirmation, API-key auth, and realtime feeds', async () => {
  const payrailCalls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const payrail = {
    fetch: async (request: Request) => {
      payrailCalls.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });

      const url = new URL(request.url);
      if (url.pathname === '/pay') {
        assert.equal(url.searchParams.get('ship'), 'edgarflash');
        assert.equal(url.searchParams.get('sku'), 'edgarflash:pro');
        assert.equal(url.searchParams.get('amount'), '99');
        return Response.json({
          quote_id: 'quote_pro_1',
          pay_to: {
            rail: 'crypto',
            chain: 'base',
            asset: 'USDC',
            address: '0xabc',
            amount: '99',
          },
          checkout: 'https://pay.example/quote_pro_1',
          instructions: 'pay with memo quote_pro_1',
          expires_in_seconds: 900,
        });
      }

      if (url.pathname === '/receipt') {
        assert.equal(request.method, 'POST');
        const payload = JSON.parse(await request.clone().text());
        assert.equal(payload.quote_id, 'quote_pro_1');
        assert.equal(payload.tx_hash, '0xpaid');
        assert.match(request.headers.get('x-payrail-signature') ?? '', /^[a-f0-9]{64}$/);
        return Response.json({ ok: true });
      }

      throw new Error(`unexpected payrail request ${request.url}`);
    },
  };
  const { env } = createEnv({ PAYRAIL: payrail, SHIP_HMAC_SECRET: 'ship-secret' });

  const paidWithoutWebhook = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email: 'paid@example.com', plan: 'pro' }),
  }), env as any);
  assert.equal(paidWithoutWebhook.status, 400);
  assert.deepEqual(await json(paidWithoutWebhook), { error: 'paid plans require webhook_url' });

  const tooManyTickers = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'paid@example.com',
      webhook_url: 'https://hooks.example/pro',
      plan: 'pro',
      tickers: Array.from({ length: 26 }, (_, i) => `T${i}`),
    }),
  }), env as any);
  assert.equal(tooManyTickers.status, 400);
  assert.equal((await json(tooManyTickers)).error, 'pro plan allows up to 25 ticker filters');

  const checkout = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'Paid@Example.com',
      webhook_url: 'https://hooks.example/pro',
      plan: 'pro',
      tickers: ['aapl', 'msft', 'aapl'],
    }),
  }), env as any);
  assert.equal(checkout.status, 402);
  const checkoutBody = await json(checkout);
  assert.equal(checkoutBody.status, 'payment_required');
  assert.equal(checkoutBody.amount_usd, '99');
  assert.equal(checkoutBody.quote_id, 'quote_pro_1');

  const pendingRaw = await env.EF_SUBS.get('pending:quote_pro_1');
  assert.ok(pendingRaw);
  assert.deepEqual(JSON.parse(pendingRaw), {
    quote_id: 'quote_pro_1',
    subscription_id: checkoutBody.subscription_id,
    plan: 'pro',
  });

  const storedSub = JSON.parse(await env.EF_SUBS.get(`sub:${checkoutBody.subscription_id}`));
  assert.equal(storedSub.active, false);
  assert.deepEqual(storedSub.tickers, ['AAPL', 'MSFT']);

  const confirm = await worker.fetch(req('/api/confirm', {
    method: 'POST',
    body: JSON.stringify({ quote_id: 'quote_pro_1', tx_hash: '0xpaid' }),
  }), env as any);
  assert.equal(confirm.status, 200);
  const confirmBody = await json(confirm);
  assert.equal(confirmBody.status, 'active');
  assert.equal(confirmBody.subscription_id, checkoutBody.subscription_id);
  assert.match(confirmBody.api_key, /^ef_live_ak_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(confirmBody.api_key_id, /^ak_/);
  assert.equal(await env.EF_SUBS.get('pending:quote_pro_1'), null);

  const activeSub = JSON.parse(await env.EF_SUBS.get(`sub:${checkoutBody.subscription_id}`));
  assert.equal(activeSub.active, true);
  assert.equal(activeSub.payment_quote_id, 'quote_pro_1');
  assert.equal(activeSub.payment_tx_hash, '0xpaid');
  assert.equal(await env.EF_SUBS.get(`api:${activeSub.api_key_id}`), checkoutBody.subscription_id);

  await seedFeed(env, [filing('newest', 1), filing('older', 30)]);

  const realtime = await worker.fetch(req('/api/realtime', {
    headers: { Authorization: `Bearer ${confirmBody.api_key}` },
  }), env as any);
  assert.equal(realtime.status, 200);
  const realtimeBody = await json(realtime);
  assert.equal(realtimeBody.realtime, true);
  assert.equal(realtimeBody.tier, 'pro');
  assert.equal(realtimeBody.count, 2);

  const feedWithQueryKey = await worker.fetch(req(`/api/feed?api_key=${encodeURIComponent(confirmBody.api_key)}`), env as any);
  assert.equal(feedWithQueryKey.status, 200);
  assert.equal((await json(feedWithQueryKey)).realtime, true);

  const badKey = await worker.fetch(req('/api/realtime', {
    headers: { 'x-api-key': `${confirmBody.api_key}x` },
  }), env as any);
  assert.equal(badKey.status, 401);
  assert.deepEqual(await json(badKey), { error: 'invalid_api_key' });

  activeSub.current_period_end = new Date(Date.now() - 1000).toISOString();
  await env.EF_SUBS.put(`sub:${checkoutBody.subscription_id}`, JSON.stringify(activeSub));
  const expired = await worker.fetch(req('/api/realtime', {
    headers: { Authorization: `Bearer ${confirmBody.api_key}` },
  }), env as any);
  assert.equal(expired.status, 403);
  assert.deepEqual(await json(expired), { error: 'inactive_subscription' });

  assert.equal(payrailCalls.length, 2);
});

test('sanitizes upstream failures and unexpected API errors', async () => {
  const payrailThrows = {
    fetch: async () => {
      throw new Error('upstream secret detail');
    },
  };
  const { env } = createEnv({ PAYRAIL: payrailThrows });

  const checkout = await worker.fetch(req('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      email: 'paid@example.com',
      webhook_url: 'https://hooks.example/pro',
      plan: 'pro',
    }),
  }), env as any);
  assert.equal(checkout.status, 502);
  assert.deepEqual(await json(checkout), { error: 'rail_unavailable' });
  assert.deepEqual(await env.EF_SUBS.list({ prefix: 'sub:' }), { keys: [] });

  await env.EF_SUBS.put('pending:quote_pro_1', JSON.stringify({
    quote_id: 'quote_pro_1',
    subscription_id: 's_paid',
    plan: 'pro',
  }));
  await env.EF_SUBS.put('sub:s_paid', JSON.stringify({
    id: 's_paid',
    email: 'paid@example.com',
    webhook_url: 'https://hooks.example/pro',
    plan: 'pro',
    forms: ['4'],
    created_at: new Date().toISOString(),
    active: false,
    delivery_count: 0,
  }));

  const confirm = await worker.fetch(req('/api/confirm', {
    method: 'POST',
    body: JSON.stringify({ quote_id: 'quote_pro_1', tx_hash: '0xpaid' }),
  }), env as any);
  assert.equal(confirm.status, 502);
  assert.deepEqual(await json(confirm), { error: 'receipt_unavailable' });

  const status = await worker.fetch(req('/api/pay-status?quote_id=quote_pro_1'), env as any);
  assert.equal(status.status, 502);
  assert.deepEqual(await json(status), { error: 'status_unavailable' });

  const brokenState = {
    get: async () => {
      throw new Error('kv secret detail');
    },
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  };
  const { env: brokenEnv } = createEnv({ EF_STATE: brokenState });
  const safe500 = await worker.fetch(req('/api/feed', {
    headers: { 'x-request-id': 'req-safe-500' },
  }), brokenEnv as any);
  assert.equal(safe500.status, 500);
  assert.deepEqual(await json(safe500), { error: 'internal_error', request_id: 'req-safe-500' });
});

test('proxies pay status responses from payrail', async () => {
  const payrail = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/receipt/unpaid') return new Response('missing', { status: 404 });
      if (url.pathname === '/receipt/paid') return Response.json({ quote_id: 'paid', payer_ref: '0xtx' });
      return new Response('nope', { status: 500 });
    },
  };
  const { env } = createEnv({ PAYRAIL: payrail });

  const missingQuote = await worker.fetch(req('/api/pay-status'), env as any);
  assert.equal(missingQuote.status, 400);
  assert.deepEqual(await json(missingQuote), { error: 'quote_id required' });

  const unpaid = await worker.fetch(req('/api/pay-status?quote_id=unpaid'), env as any);
  assert.equal(unpaid.status, 200);
  assert.deepEqual(await json(unpaid), { paid: false, quote_id: 'unpaid' });

  const paid = await worker.fetch(req('/api/pay-status?quote_id=paid'), env as any);
  assert.equal(paid.status, 200);
  assert.deepEqual(await json(paid), { paid: true, receipt: { quote_id: 'paid', payer_ref: '0xtx' } });
});

test('scheduled polling parses EDGAR Atom, updates caches, dedupes, and delivers webhooks', async () => {
  const { env } = createEnv();
  const webhookBodies: any[] = [];
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.EF_SUBS.put('sub:s_paid', JSON.stringify({
    id: 's_paid',
    email: 'paid@example.com',
    webhook_url: 'https://hooks.example/sec',
    plan: 'pro',
    forms: ['4', '8-K'],
    tickers: ['ACME'],
    created_at: new Date().toISOString(),
    active: true,
    current_period_end: future,
    delivery_count: 0,
  }));

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname === 'www.sec.gov') {
      assert.equal(request.headers.get('User-Agent'), env.USER_AGENT);
      const form = url.searchParams.get('type');
      if (form === '4') {
        return new Response(atomFeed([atomEntry({
          id: 'filing-4-1',
          title: '4 - ACME HOLDINGS INC (0001234567) (Filer)',
          updated: '2026-06-19T10:00:00Z',
          href: 'https://www.sec.gov/Archives/edgar/data/1234567/4.html',
          summary: '<b>Owner</b>&nbsp;transaction filed',
        })]), { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
      }
      if (form === '8-K') {
        return new Response(atomFeed([atomEntry({
          id: 'filing-8k-1',
          title: '8-K - OTHER COMPANY (0007654321) (Filer)',
          updated: '2026-06-19T10:01:00Z',
          href: 'https://www.sec.gov/Archives/edgar/data/7654321/8-k.html',
          summary: 'material event',
        })]), { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
      }
    }

    if (url.href === 'https://hooks.example/sec') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('Content-Type'), 'application/json');
      webhookBodies.push(JSON.parse(await request.text()));
      return Response.json({ ok: true });
    }

    throw new Error(`unexpected fetch ${request.url}`);
  };

  await runScheduled(env);

  const cachedFeed = JSON.parse(await env.EF_STATE.get('feed:recent'));
  assert.deepEqual(cachedFeed.map((f: any) => f.id), ['filing-4-1', 'filing-8k-1']);
  assert.equal(cachedFeed[0].company, 'ACME HOLDINGS INC');
  assert.equal(cachedFeed[0].cik, '0001234567');
  assert.equal(cachedFeed[0].summary, 'Owner transaction filed');
  assert.deepEqual(JSON.parse(await env.EF_STATE.get('last_seen_filings')), ['filing-4-1', 'filing-8k-1']);

  assert.equal(webhookBodies.length, 1);
  assert.equal(webhookBodies[0].subscription_id, 's_paid');
  assert.deepEqual(webhookBodies[0].filings.map((f: any) => f.id), ['filing-4-1']);

  const deliveredSub = JSON.parse(await env.EF_SUBS.get('sub:s_paid'));
  assert.equal(deliveredSub.delivery_count, 1);
  assert.ok(deliveredSub.last_delivery_at);

  const status = await worker.fetch(req('/api/status'), env as any);
  assert.equal(status.status, 200);
  const statusBody = await json(status);
  assert.equal(statusBody.feed_size, 2);
  assert.equal(statusBody.subscriber_count, 1);
  assert.equal(statusBody.active_paid_subscriber_count, 1);
  assert.equal(statusBody.last_filing, '2026-06-19T10:00:00Z');

  await runScheduled(env);
  assert.equal(webhookBodies.length, 1);
  const dedupedSub = JSON.parse(await env.EF_SUBS.get('sub:s_paid'));
  assert.equal(dedupedSub.delivery_count, 1);
});

test('scheduled webhook delivery does not count failed webhook responses', async () => {
  const { env } = createEnv();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.EF_SUBS.put('sub:s_paid', JSON.stringify({
    id: 's_paid',
    email: 'paid@example.com',
    webhook_url: 'https://hooks.example/sec',
    plan: 'pro',
    forms: ['4'],
    created_at: new Date().toISOString(),
    active: true,
    current_period_end: future,
    delivery_count: 0,
  }));

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname === 'www.sec.gov') {
      const form = url.searchParams.get('type');
      if (form === '4') {
        return new Response(atomFeed([atomEntry({
          id: 'filing-4-failed-hook',
          title: '4 - ACME HOLDINGS INC (0001234567) (Filer)',
          updated: '2026-06-19T10:00:00Z',
          href: 'https://www.sec.gov/Archives/edgar/data/1234567/4.html',
          summary: 'owner transaction filed',
        })]), { status: 200 });
      }
      return new Response(atomFeed([]), { status: 200 });
    }

    if (url.href === 'https://hooks.example/sec') return new Response('down', { status: 500 });
    throw new Error(`unexpected fetch ${request.url}`);
  };

  await runScheduled(env);

  const deliveredSub = JSON.parse(await env.EF_SUBS.get('sub:s_paid'));
  assert.equal(deliveredSub.delivery_count, 0);
  assert.equal(deliveredSub.last_delivery_at, undefined);
});

async function runScheduled(env: any) {
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as any, env, {
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
  } as any);
  await Promise.all(waits);
}

function atomFeed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries.join('')}</feed>`;
}

function atomEntry(input: {
  id: string;
  title: string;
  updated: string;
  href: string;
  summary: string;
}): string {
  return `<entry>
    <title>${input.title}</title>
    <link href="${input.href}" />
    <updated>${input.updated}</updated>
    <id>${input.id}</id>
    <summary>${input.summary}</summary>
  </entry>`;
}
