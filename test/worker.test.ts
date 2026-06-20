import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, { hashApiKey } from '../src/index';

class MemoryKV {
  store = new Map<string, string>();
  putOptions = new Map<string, unknown>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: unknown, options?: unknown): Promise<void> {
    this.store.set(key, String(value));
    if (options !== undefined) this.putOptions.set(key, options);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix ?? '';
    return {
      keys: [...this.store.keys()]
        .filter(name => name.startsWith(prefix))
        .sort()
        .map(name => ({ name })),
    };
  }
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const assetsRequests: Request[] = [];
  const env = {
    ASSETS: {
      fetch: async (request: Request) => {
        assetsRequests.push(request);
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

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://edgarflash.test${path}`, init);
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
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

async function seedFeed(env: { EF_STATE: MemoryKV }, filings: unknown[]) {
  await env.EF_STATE.put('feed:recent', JSON.stringify(filings));
}

async function fetchWorker(path: string, env: unknown, init?: RequestInit): Promise<Response> {
  return worker.fetch(request(path, init), env as Parameters<typeof worker.fetch>[1]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worker feed and subscription routes', () => {
  it('serves the delayed public feed, rejects missing realtime keys, and falls back to assets', async () => {
    const { env, assetsRequests } = createEnv();
    const recent = filing('recent', 1);
    const oldFilings = Array.from({ length: 12 }, (_, i) => filing(`old-${i}`, 16 + i));
    await seedFeed(env, [recent, ...oldFilings]);

    const missingRealtimeKey = await fetchWorker('/api/realtime', env);
    expect(missingRealtimeKey.status).toBe(401);
    expect(await readJson(missingRealtimeKey)).toEqual({ error: 'api_key_required' });

    const feed = await fetchWorker('/api/feed', env);
    expect(feed.status).toBe(200);
    const body = await readJson<{
      tier: string;
      realtime: boolean;
      delayed_minutes: number;
      limit: number;
      total_cached: number;
      count: number;
      filings: Array<{ id: string }>;
    }>(feed);

    expect(body.tier).toBe('free');
    expect(body.realtime).toBe(false);
    expect(body.delayed_minutes).toBe(15);
    expect(body.limit).toBe(10);
    expect(body.total_cached).toBe(13);
    expect(body.count).toBe(10);
    expect(body.filings.map(f => f.id)).toEqual(oldFilings.slice(0, 10).map(f => f.id));

    const missingSub = await fetchWorker('/api/subscription/s_missing', env);
    expect(missingSub.status).toBe(404);
    expect(await readJson(missingSub)).toEqual({ error: 'not found' });

    const asset = await fetchWorker('/', env);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('asset fallback');
    expect(assetsRequests).toHaveLength(1);
  });

  it('validates free subscriptions and keeps private fields out of public responses', async () => {
    const { env } = createEnv();

    const getSubscribe = await fetchWorker('/api/subscribe', env);
    expect(getSubscribe.status).toBe(405);
    expect(await getSubscribe.text()).toBe('method not allowed');

    const invalidJson = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    expect(await readJson(invalidJson)).toEqual({ error: 'invalid JSON' });

    const badEmail = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(badEmail.status).toBe(400);
    expect(await readJson(badEmail)).toEqual({ error: 'valid email required' });

    const badForms = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({ email: 'person@example.com', forms: ['10-K'] }),
    });
    expect(badForms.status).toBe(400);
    expect(await readJson(badForms)).toEqual({ error: 'forms must include one of: 4, 8-K' });

    const freeWithTickers = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({ email: 'person@example.com', tickers: ['AAPL'] }),
    });
    expect(freeWithTickers.status).toBe(400);
    expect(await readJson(freeWithTickers)).toEqual({ error: 'free plan allows up to 0 ticker filters' });

    const created = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({
        email: 'Person@Example.COM ',
        forms: ['4', '4', '8-K', '10-K'],
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = await readJson<{ subscription_id: string; status: string; plan: string }>(created);
    expect(createdBody.status).toBe('active');
    expect(createdBody.plan).toBe('free');

    const storedRaw = await env.EF_SUBS.get(`sub:${createdBody.subscription_id}`);
    expect(storedRaw).not.toBeNull();
    expect(JSON.parse(storedRaw ?? '{}')).toMatchObject({
      email: 'person@example.com',
      plan: 'free',
      active: true,
      forms: ['4', '8-K'],
    });

    const publicSub = await fetchWorker(`/api/subscription/${createdBody.subscription_id}`, env);
    expect(publicSub.status).toBe(200);
    const publicBody = await readJson<Record<string, unknown>>(publicSub);
    expect(publicBody).toMatchObject({
      id: createdBody.subscription_id,
      plan: 'free',
      active: true,
      realtime_api: false,
      forms: ['4', '8-K'],
      delivery_count: 0,
    });
    expect(publicBody).not.toHaveProperty('webhook_url');
    expect(publicBody).not.toHaveProperty('api_key_hash');
  });
});

describe('worker paid access and payrail routes', () => {
  it('runs institutional checkout, confirmation, API-key auth, and realtime feeds', async () => {
    const payrailCalls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const payrail = {
      fetch: vi.fn(async (request: Request) => {
        payrailCalls.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.clone().text(),
        });

        const url = new URL(request.url);
        if (url.pathname === '/pay') {
          expect(url.searchParams.get('ship')).toBe('edgarflash');
          expect(url.searchParams.get('sku')).toBe('edgarflash:institutional');
          expect(url.searchParams.get('amount')).toBe('299');
          expect(url.searchParams.get('currency')).toBe('USDC');
          return Response.json({
            quote_id: 'quote_inst_1',
            pay_to: {
              rail: 'crypto',
              chain: 'base',
              asset: 'USDC',
              address: '0xabc',
              amount: '299',
            },
            checkout: 'https://pay.example/quote_inst_1',
            instructions: 'pay with memo quote_inst_1',
            expires_in_seconds: 900,
          });
        }

        if (url.pathname === '/receipt') {
          expect(request.method).toBe('POST');
          const payload = JSON.parse(await request.clone().text());
          expect(payload).toMatchObject({
            quote_id: 'quote_inst_1',
            ship: 'edgarflash',
            sku: 'edgarflash:institutional',
            amount: '299',
            currency: 'USDC',
            rail: 'crypto',
            tx_hash: '0xpaid',
          });
          expect(request.headers.get('x-payrail-signature')).toMatch(/^[a-f0-9]{64}$/);
          return Response.json({ ok: true });
        }

        throw new Error(`unexpected payrail request ${request.url}`);
      }),
    };
    const { env } = createEnv({ PAYRAIL: payrail, SHIP_HMAC_SECRET: 'ship-secret' });

    const paidWithoutWebhook = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({ email: 'paid@example.com', plan: 'institutional' }),
    });
    expect(paidWithoutWebhook.status).toBe(400);
    expect(await readJson(paidWithoutWebhook)).toEqual({ error: 'paid plans require webhook_url' });

    const tooManyTickers = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({
        email: 'paid@example.com',
        webhook_url: 'https://hooks.example/institutional',
        plan: 'institutional',
        tickers: Array.from({ length: 101 }, (_, i) => `T${i}`),
      }),
    });
    expect(tooManyTickers.status).toBe(400);
    expect(await readJson(tooManyTickers)).toEqual({
      error: 'institutional plan allows up to 100 ticker filters',
    });

    const checkout = await fetchWorker('/api/subscribe', env, {
      method: 'POST',
      body: JSON.stringify({
        email: 'Paid@Example.com',
        webhook_url: 'https://hooks.example/institutional',
        plan: 'institutional',
        tickers: ['aapl', 'msft', 'aapl'],
      }),
    });
    expect(checkout.status).toBe(402);
    const checkoutBody = await readJson<{
      status: string;
      amount_usd: string;
      ticker_limit: number;
      subscription_id: string;
      quote_id: string;
    }>(checkout);
    expect(checkoutBody).toMatchObject({
      status: 'payment_required',
      amount_usd: '299',
      ticker_limit: 100,
      quote_id: 'quote_inst_1',
    });

    expect(JSON.parse(await env.EF_SUBS.get('pending:quote_inst_1') ?? '{}')).toEqual({
      quote_id: 'quote_inst_1',
      subscription_id: checkoutBody.subscription_id,
      plan: 'institutional',
    });
    expect(env.EF_SUBS.putOptions.get('pending:quote_inst_1')).toEqual({ expirationTtl: 60 * 60 * 24 * 7 });

    const pendingSub = JSON.parse(await env.EF_SUBS.get(`sub:${checkoutBody.subscription_id}`) ?? '{}');
    expect(pendingSub).toMatchObject({
      email: 'paid@example.com',
      webhook_url: 'https://hooks.example/institutional',
      active: false,
      tickers: ['AAPL', 'MSFT'],
    });

    const confirm = await fetchWorker('/api/confirm', env, {
      method: 'POST',
      body: JSON.stringify({ quote_id: 'quote_inst_1', tx_hash: '0xpaid' }),
    });
    expect(confirm.status).toBe(200);
    const confirmBody = await readJson<{
      status: string;
      subscription_id: string;
      plan: string;
      api_key: string;
      api_key_id: string;
      realtime_feed_url: string;
      realtime_endpoint: string;
    }>(confirm);
    expect(confirmBody.status).toBe('active');
    expect(confirmBody.subscription_id).toBe(checkoutBody.subscription_id);
    expect(confirmBody.plan).toBe('institutional');
    expect(confirmBody.api_key).toMatch(/^ef_live_ak_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(confirmBody.api_key_id).toMatch(/^ak_/);
    expect(confirmBody.realtime_feed_url).toBe('/api/feed');
    expect(confirmBody.realtime_endpoint).toBe('/api/realtime');
    expect(await env.EF_SUBS.get('pending:quote_inst_1')).toBeNull();

    const activeSub = JSON.parse(await env.EF_SUBS.get(`sub:${checkoutBody.subscription_id}`) ?? '{}');
    expect(activeSub).toMatchObject({
      active: true,
      payment_quote_id: 'quote_inst_1',
      payment_tx_hash: '0xpaid',
      api_key_id: confirmBody.api_key_id,
    });
    expect(await env.EF_SUBS.get(`api:${activeSub.api_key_id}`)).toBe(checkoutBody.subscription_id);

    await seedFeed(env, [filing('newest', 1), filing('older', 30)]);

    const realtime = await fetchWorker('/api/realtime', env, {
      headers: { Authorization: `Bearer ${confirmBody.api_key}` },
    });
    expect(realtime.status).toBe(200);
    expect(await readJson(realtime)).toMatchObject({
      realtime: true,
      tier: 'institutional',
      subscription_id: checkoutBody.subscription_id,
      count: 2,
    });

    const feedWithQueryKey = await fetchWorker(
      `/api/feed?api_key=${encodeURIComponent(confirmBody.api_key)}`,
      env,
    );
    expect(feedWithQueryKey.status).toBe(200);
    expect(await readJson(feedWithQueryKey)).toMatchObject({
      realtime: true,
      tier: 'institutional',
      count: 2,
    });

    const publicSub = await fetchWorker(`/api/subscription/${checkoutBody.subscription_id}`, env);
    expect(publicSub.status).toBe(200);
    const publicBody = await readJson<Record<string, unknown>>(publicSub);
    expect(publicBody.realtime_api).toBe(true);
    expect(publicBody.api_key_id).toBe(confirmBody.api_key_id);
    expect(publicBody).not.toHaveProperty('api_key_hash');

    activeSub.current_period_end = new Date(Date.now() - 1000).toISOString();
    await env.EF_SUBS.put(`sub:${checkoutBody.subscription_id}`, JSON.stringify(activeSub));
    const expired = await fetchWorker('/api/realtime', env, {
      headers: { Authorization: `Bearer ${confirmBody.api_key}` },
    });
    expect(expired.status).toBe(403);
    expect(await readJson(expired)).toEqual({ error: 'inactive_subscription' });

    expect(payrailCalls).toHaveLength(2);
  });

  it('returns precise API-key auth errors for broken subscription rows', async () => {
    const { env } = createEnv();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await env.EF_SUBS.put('api:ak_orphan', 'missing_sub');
    const orphan = await fetchWorker('/api/realtime', env, {
      headers: { 'x-api-key': 'ef_live_ak_orphan.secret' },
    });
    expect(orphan.status).toBe(401);
    expect(await readJson(orphan)).toEqual({ error: 'subscription_not_found' });

    await env.EF_SUBS.put('api:ak_corrupt', 'corrupt_sub');
    await env.EF_SUBS.put('sub:corrupt_sub', '{');
    const corrupt = await fetchWorker('/api/realtime', env, {
      headers: { 'x-api-key': 'ef_live_ak_corrupt.secret' },
    });
    expect(corrupt.status).toBe(500);
    expect(await readJson(corrupt)).toEqual({ error: 'subscription_corrupt' });

    await env.EF_SUBS.put('api:ak_nohash', 'nohash_sub');
    await env.EF_SUBS.put('sub:nohash_sub', JSON.stringify({
      id: 'nohash_sub',
      email: 'paid@example.com',
      plan: 'pro',
      forms: ['4'],
      created_at: new Date().toISOString(),
      active: true,
      current_period_end: future,
      delivery_count: 0,
    }));
    const noHash = await fetchWorker('/api/realtime', env, {
      headers: { 'x-api-key': 'ef_live_ak_nohash.secret' },
    });
    expect(noHash.status).toBe(403);
    expect(await readJson(noHash)).toEqual({ error: 'api_key_not_enabled' });

    await env.EF_SUBS.put('api:ak_badmatch', 'badmatch_sub');
    await env.EF_SUBS.put('sub:badmatch_sub', JSON.stringify({
      id: 'badmatch_sub',
      email: 'paid@example.com',
      plan: 'pro',
      forms: ['4'],
      created_at: new Date().toISOString(),
      active: true,
      current_period_end: future,
      api_key_hash: await hashApiKey({}, 'ef_live_ak_badmatch.other-secret'),
      delivery_count: 0,
    }));
    const badMatch = await fetchWorker('/api/realtime', env, {
      headers: { 'x-api-key': 'ef_live_ak_badmatch.secret' },
    });
    expect(badMatch.status).toBe(401);
    expect(await readJson(badMatch)).toEqual({ error: 'invalid_api_key' });
  });

  it('proxies pay status through the configured public payrail URL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get('user-agent')).toBe(
        'Mozilla/5.0 (compatible; edgarflash/1.0; +https://edgarflash.ivixivi.workers.dev)',
      );

      const url = new URL(request.url);
      if (url.pathname === '/receipt/unpaid') return new Response('missing', { status: 404 });
      if (url.pathname === '/receipt/paid') return Response.json({ quote_id: 'paid', payer_ref: '0xtx' });
      return new Response('upstream unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { env } = createEnv({ PAYRAIL_URL: 'https://pay.local' });

    const missingQuote = await fetchWorker('/api/pay-status', env);
    expect(missingQuote.status).toBe(400);
    expect(await readJson(missingQuote)).toEqual({ error: 'quote_id required' });

    const unpaid = await fetchWorker('/api/pay-status?quote_id=unpaid', env);
    expect(unpaid.status).toBe(200);
    expect(await readJson(unpaid)).toEqual({ paid: false, quote_id: 'unpaid' });

    const paid = await fetchWorker('/api/pay-status?quote_id=paid', env);
    expect(paid.status).toBe(200);
    expect(await readJson(paid)).toEqual({ paid: true, receipt: { quote_id: 'paid', payer_ref: '0xtx' } });

    const down = await fetchWorker('/api/pay-status?quote_id=down', env);
    expect(down.status).toBe(502);
    expect(await readJson(down)).toEqual({ error: 'status_unavailable', status: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://pay.local/receipt/unpaid',
      'https://pay.local/receipt/paid',
      'https://pay.local/receipt/down',
    ]);
  });
});

describe('scheduled EDGAR polling', () => {
  it('parses Atom feeds, updates caches, dedupes, and delivers matching webhooks', async () => {
    const { env } = createEnv();
    const webhookBodies: Array<{ subscription_id: string; filings: Array<{ id: string }> }> = [];
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

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.hostname === 'www.sec.gov') {
        expect(request.headers.get('User-Agent')).toBe(env.USER_AGENT);
        expect(request.headers.get('Accept')).toBe('application/atom+xml');
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
        expect(request.method).toBe('POST');
        expect(request.headers.get('Content-Type')).toBe('application/json');
        expect(request.headers.get('User-Agent')).toBe('EdgarFlash/0.1');
        webhookBodies.push(JSON.parse(await request.text()));
        return Response.json({ ok: true });
      }

      throw new Error(`unexpected fetch ${request.url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await runScheduled(env);

    const cachedFeed = JSON.parse(await env.EF_STATE.get('feed:recent') ?? '[]');
    expect(cachedFeed.map((f: { id: string }) => f.id)).toEqual(['filing-4-1', 'filing-8k-1']);
    expect(cachedFeed[0]).toMatchObject({
      company: 'ACME HOLDINGS INC',
      cik: '0001234567',
      summary: 'Owner transaction filed',
    });
    expect(JSON.parse(await env.EF_STATE.get('last_seen_filings') ?? '[]')).toEqual([
      'filing-4-1',
      'filing-8k-1',
    ]);

    expect(webhookBodies).toHaveLength(1);
    expect(webhookBodies[0].subscription_id).toBe('s_paid');
    expect(webhookBodies[0].filings.map(f => f.id)).toEqual(['filing-4-1']);

    const deliveredSub = JSON.parse(await env.EF_SUBS.get('sub:s_paid') ?? '{}');
    expect(deliveredSub.delivery_count).toBe(1);
    expect(deliveredSub.last_delivery_at).toEqual(expect.any(String));

    const status = await fetchWorker('/api/status', env);
    expect(status.status).toBe(200);
    expect(await readJson(status)).toMatchObject({
      name: 'EdgarFlash',
      feed_size: 2,
      subscriber_count: 1,
      subscriber_breakdown: { free: 0, pro: 1, institutional: 0 },
      active_paid_subscriber_count: 1,
      last_filing: '2026-06-19T10:00:00Z',
      free_feed: { delayed_minutes: 15, limit: 10 },
      plan_limits: { ticker_filters: { free: 0, pro: 25, institutional: 100 } },
    });

    await runScheduled(env);
    expect(webhookBodies).toHaveLength(1);
    const dedupedSub = JSON.parse(await env.EF_SUBS.get('sub:s_paid') ?? '{}');
    expect(dedupedSub.delivery_count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

async function runScheduled(env: unknown) {
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({} as ScheduledEvent, env as Parameters<typeof worker.scheduled>[1], {
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
  } as ExecutionContext);
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
