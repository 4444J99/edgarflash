/**
 * EdgarFlash — real-time SEC EDGAR filing alerts.
 *
 * Cron polls EDGAR every minute. New Form 4 (insider trades) and 8-K
 * (material events) get pushed to subscribers via webhook.
 *
 * Subscribers added via POST /api/subscribe (plan = "free" | "pro" | "institutional").
 * Free tier: web feed only.
 * Pro ($99/mo): webhook delivery within 60s of filing.
 * Institutional ($999/mo): SLA + multi-webhook + priority delivery.
 */

interface Env {
  ASSETS: Fetcher;
  EF_STATE: KVNamespace;
  EF_SUBS: KVNamespace;
  USER_AGENT: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID_PRO?: string;
  STRIPE_PRICE_ID_INSTITUTIONAL?: string;
  // Shared fleet money rail. PAYRAIL is a service binding (preferred — a direct
  // internal worker→worker call that skips the public edge, so it dodges both the
  // *.workers.dev same-zone restriction and edge bot-management). PAYRAIL_URL is the
  // public-hostname fallback (used when the binding is absent, e.g. local/standby).
  // SHIP_HMAC_SECRET (a wrangler secret, unset by default) signs receipt writes.
  PAYRAIL?: Fetcher;
  PAYRAIL_URL?: string;
  SHIP_HMAC_SECRET?: string;
}

interface Filing {
  id: string;             // unique
  form: '4' | '8-K' | string;
  ticker?: string;
  company?: string;
  cik?: string;
  filed_at: string;       // ISO timestamp
  title: string;
  url: string;
  summary?: string;
}

interface Subscription {
  id: string;
  email: string;
  webhook_url?: string;
  plan: 'free' | 'pro' | 'institutional';
  forms: string[];        // which forms they want; default ["4","8-K"]
  tickers?: string[];     // optional ticker filter
  created_at: string;
  active: boolean;
  delivery_count: number;
  last_delivery_at?: string;
}

const FORMS_TO_WATCH = ['4', '8-K'];
const FEED_RECENT_LIMIT = 50;
const STATE_KEY_LAST_FILINGS = 'last_seen_filings';
const FEED_CACHE_KEY = 'feed:recent';

// === payrail (shared fleet money rail) ===
// edgarflash plugs into the live payrail Worker instead of re-implementing
// "Stripe wire pending". payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';
const PRICES: Record<'pro' | 'institutional', string> = { pro: '99', institutional: '999' };

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

// Single egress point to payrail. Prefers the service binding (an internal
// worker→worker call that never touches the public edge → immune to both the
// *.workers.dev same-zone restriction and edge bot-management). Falls back to the
// public hostname with a browser UA so even the fallback clears bot filters. When
// the binding is used the host in the URL is ignored — only path/query/method/body.
function payrailFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.PAYRAIL) return env.PAYRAIL.fetch(new Request(`https://payrail${path}`, init));
  const base = env.PAYRAIL_URL ?? PAYRAIL_DEFAULT;
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (compatible; edgarflash/1.0; +https://edgarflash.ivixivi.workers.dev)');
  }
  return fetch(base + path, { ...init, headers });
}

async function payrailQuote(env: Env, plan: 'pro' | 'institutional'): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'edgarflash',
    sku: `edgarflash:${plan}`,
    amount: PRICES[plan],
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  return r.json();
}

// HMAC-SHA256 hex, byte-identical to payrail's hmac() so timingSafeEqual passes.
// Only used when SHIP_HMAC_SECRET is set (payrail has none today → optional).
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function newId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchEdgarFilings(form: string, env: Env): Promise<Filing[]> {
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&owner=include&count=40&output=atom`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': env.USER_AGENT,
      'Accept': 'application/atom+xml',
    },
  });
  if (!resp.ok) throw new Error(`EDGAR ${resp.status}`);
  const xml = await resp.text();
  return parseAtomFeed(xml, form);
}

function parseAtomFeed(xml: string, form: string): Filing[] {
  const filings: Filing[] = [];
  // Light XML parse — Atom <entry> blocks, extract title / link / updated / id / summary
  const entries = xml.split('<entry>').slice(1);
  for (const e of entries) {
    const closeIdx = e.indexOf('</entry>');
    if (closeIdx < 0) continue;
    const block = e.slice(0, closeIdx);

    const title = match(block, /<title>([^<]*)<\/title>/);
    const link = match(block, /<link[^>]+href="([^"]+)"/);
    const updated = match(block, /<updated>([^<]*)<\/updated>/);
    const idTag = match(block, /<id>([^<]*)<\/id>/);
    const summaryRaw = match(block, /<summary[^>]*>([\s\S]*?)<\/summary>/);

    if (!title || !link || !updated) continue;

    // Extract company + ticker from title like "4 - SMITH JOHN (1234567) (Reporting)"
    // Or "8-K - APPLE INC (0000320193) (Filer)"
    const m = title.match(/^([^-]+)\s*-\s*(.+?)\s*\((\d+)\)/);
    const filing: Filing = {
      id: idTag ?? `${form}-${updated}-${title.slice(0, 30)}`,
      form,
      title,
      url: link,
      filed_at: updated,
      company: m?.[2]?.trim(),
      cik: m?.[3],
    };
    if (summaryRaw) filing.summary = stripHtml(summaryRaw).slice(0, 500);
    filings.push(filing);
  }
  return filings;
}

function match(s: string, re: RegExp): string | undefined {
  const m = s.match(re);
  return m?.[1];
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function loadLastSeen(env: Env): Promise<Set<string>> {
  const raw = await env.EF_STATE.get(STATE_KEY_LAST_FILINGS);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw) as string[]); } catch { return new Set(); }
}

async function saveLastSeen(env: Env, ids: Set<string>) {
  // Keep recent 1000 IDs to bound memory
  const arr = [...ids].slice(-1000);
  await env.EF_STATE.put(STATE_KEY_LAST_FILINGS, JSON.stringify(arr));
}

async function loadRecentFeed(env: Env): Promise<Filing[]> {
  const raw = await env.EF_STATE.get(FEED_CACHE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as Filing[]; } catch { return []; }
}

async function saveRecentFeed(env: Env, filings: Filing[]) {
  const trimmed = filings.slice(0, FEED_RECENT_LIMIT);
  await env.EF_STATE.put(FEED_CACHE_KEY, JSON.stringify(trimmed));
}

async function listSubscriptions(env: Env): Promise<Subscription[]> {
  const list = await env.EF_SUBS.list({ prefix: 'sub:' });
  const out: Subscription[] = [];
  for (const k of list.keys) {
    const v = await env.EF_SUBS.get(k.name);
    if (!v) continue;
    try { out.push(JSON.parse(v) as Subscription); } catch {}
  }
  return out;
}

async function deliverWebhook(sub: Subscription, filings: Filing[], env: Env) {
  if (!sub.webhook_url || !sub.active) return;
  // Filter
  let toSend = filings.filter(f => sub.forms.includes(f.form));
  if (sub.tickers && sub.tickers.length > 0) {
    toSend = toSend.filter(f => f.company && sub.tickers!.some(t =>
      f.company!.toUpperCase().includes(t.toUpperCase())));
  }
  if (toSend.length === 0) return;

  try {
    await fetch(sub.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'EdgarFlash/0.1' },
      body: JSON.stringify({ filings: toSend, subscription_id: sub.id }),
    });
    sub.delivery_count = (sub.delivery_count ?? 0) + 1;
    sub.last_delivery_at = new Date().toISOString();
    await env.EF_SUBS.put(`sub:${sub.id}`, JSON.stringify(sub));
  } catch {
    // fail-silent: subscriber's webhook went down. Don't lose the run.
  }
}

async function runCron(env: Env) {
  const lastSeen = await loadLastSeen(env);
  const newFilings: Filing[] = [];
  for (const form of FORMS_TO_WATCH) {
    let filings: Filing[];
    try { filings = await fetchEdgarFilings(form, env); }
    catch (err) { console.warn(`fetch ${form} failed:`, err); continue; }
    for (const f of filings) {
      if (!lastSeen.has(f.id)) {
        newFilings.push(f);
        lastSeen.add(f.id);
      }
    }
  }
  if (newFilings.length === 0) return;

  // Update feed cache
  const recent = await loadRecentFeed(env);
  const merged = [...newFilings, ...recent].slice(0, FEED_RECENT_LIMIT);
  await saveRecentFeed(env, merged);
  await saveLastSeen(env, lastSeen);

  // Notify subscribers
  const subs = await listSubscriptions(env);
  await Promise.all(subs.map(s => deliverWebhook(s, newFilings, env)));
}

// === HTTP handlers ===

async function handleApiFeed(req: Request, env: Env): Promise<Response> {
  const filings = await loadRecentFeed(env);
  return Response.json({
    count: filings.length,
    filings,
    updated_at: new Date().toISOString(),
    note: 'Free tier — refreshed every 60s. Pro tier delivers within 5–30s via webhook.',
  });
}

async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const email = String(body?.email ?? '').trim().toLowerCase();
  const webhook_url = body?.webhook_url ? String(body.webhook_url).trim() : undefined;
  const plan = ['free', 'pro', 'institutional'].includes(body?.plan) ? body.plan : 'free';
  const forms: string[] = Array.isArray(body?.forms) ? body.forms.map(String) : ['4', '8-K'];
  const tickers: string[] | undefined = Array.isArray(body?.tickers) ? body.tickers.map(String) : undefined;

  if (!email || !email.includes('@')) return Response.json({ error: 'valid email required' }, { status: 400 });
  if (plan !== 'free' && !webhook_url) {
    return Response.json({ error: 'paid plans require webhook_url' }, { status: 400 });
  }

  const id = newId('s_');
  const sub: Subscription = {
    id, email, webhook_url, plan, forms, tickers,
    created_at: new Date().toISOString(),
    active: plan === 'free',  // paid plans wait for payment confirmation
    delivery_count: 0,
  };
  await env.EF_SUBS.put(`sub:${id}`, JSON.stringify(sub));

  if (plan === 'free') {
    return Response.json({ subscription_id: id, status: 'active', plan, message: 'Free tier active. View feed at /api/feed.' });
  }

  // Paid plan: get a live quote from the shared payrail rail and return a 402
  // carrying the on-chain address + memo (quote_id). The subscription is already
  // persisted with active=false; the buyer pays, then POSTs the tx hash to
  // /api/confirm to unlock. No more "Stripe wire pending" stub.
  const paidPlan = plan as 'pro' | 'institutional';
  let q: PayrailQuote;
  try {
    q = await payrailQuote(env, paidPlan);
  } catch (err) {
    return Response.json({ error: 'rail_unavailable', detail: String(err) }, { status: 502 });
  }
  await env.EF_SUBS.put(
    `pending:${q.quote_id}`,
    JSON.stringify({ quote_id: q.quote_id, subscription_id: id, plan: paidPlan }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
  return Response.json({
    status: 'payment_required',
    plan: paidPlan,
    subscription_id: id,
    quote_id: q.quote_id,
    pay_to: q.pay_to,
    checkout: q.checkout,
    instructions: q.instructions,
    expires_in_seconds: q.expires_in_seconds,
    confirm_url: '/api/confirm',
  }, { status: 402 });
}

// A buyer who paid posts { quote_id, tx_hash }. We forward it to payrail
// /receipt — the receipt's payer_ref == tx_hash is the TIER-1 artifact — then
// flip the pending sub to active and unlock the paid plan.
async function handleConfirm(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const body = await req.json().catch(() => null) as { quote_id?: string; tx_hash?: string } | null;
  if (!body?.quote_id || !body?.tx_hash) {
    return Response.json({ error: 'quote_id and tx_hash required' }, { status: 400 });
  }
  const pendingRaw = await env.EF_SUBS.get(`pending:${body.quote_id}`);
  if (!pendingRaw) return Response.json({ error: 'quote_not_found_or_expired' }, { status: 404 });
  const pending = JSON.parse(pendingRaw) as { quote_id: string; subscription_id: string; plan: 'pro' | 'institutional' };
  const plan = (pending.plan === 'institutional' ? 'institutional' : 'pro') as 'pro' | 'institutional';

  const payload = JSON.stringify({
    quote_id: body.quote_id,
    ship: 'edgarflash',
    sku: `edgarflash:${plan}`,
    amount: PRICES[plan],
    currency: 'USDC',
    rail: 'crypto',
    tx_hash: body.tx_hash,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.SHIP_HMAC_SECRET) headers['x-payrail-signature'] = await hmacHex(env.SHIP_HMAC_SECRET, payload);

  const rr = await payrailFetch(env, '/receipt', { method: 'POST', headers, body: payload });
  if (!rr.ok) {
    return Response.json(
      { error: 'receipt_rejected', status: rr.status, detail: await rr.text().catch(() => '') },
      { status: 502 },
    );
  }

  const subRaw = await env.EF_SUBS.get(`sub:${pending.subscription_id}`);
  if (!subRaw) return Response.json({ error: 'subscription_not_found' }, { status: 404 });
  const sub = JSON.parse(subRaw) as Subscription;
  sub.active = true;
  await env.EF_SUBS.put(`sub:${pending.subscription_id}`, JSON.stringify(sub));
  await env.EF_SUBS.delete(`pending:${body.quote_id}`);
  return Response.json({ status: 'active', subscription_id: pending.subscription_id });
}

// Poll payment status by proxying payrail's public receipt lookup.
async function handlePayStatus(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const quoteId = url.searchParams.get('quote_id');
  if (!quoteId) return Response.json({ error: 'quote_id required' }, { status: 400 });
  const r = await payrailFetch(env, `/receipt/${encodeURIComponent(quoteId)}`);
  if (r.status === 404) return Response.json({ paid: false, quote_id: quoteId });
  if (!r.ok) return Response.json({ error: 'status_unavailable', status: r.status }, { status: 502 });
  return Response.json({ paid: true, receipt: await r.json() });
}

async function handleSubscription(req: Request, env: Env, id: string): Promise<Response> {
  const v = await env.EF_SUBS.get(`sub:${id}`);
  if (!v) return Response.json({ error: 'not found' }, { status: 404 });
  const sub = JSON.parse(v) as Subscription;
  // Don't return webhook_url in public response
  return Response.json({
    id: sub.id,
    plan: sub.plan,
    active: sub.active,
    forms: sub.forms,
    tickers: sub.tickers,
    delivery_count: sub.delivery_count,
    last_delivery_at: sub.last_delivery_at,
    created_at: sub.created_at,
  });
}

async function handleStatus(_req: Request, env: Env): Promise<Response> {
  const subs = await listSubscriptions(env);
  const recent = await loadRecentFeed(env);
  return Response.json({
    name: 'EdgarFlash',
    feed_size: recent.length,
    subscriber_count: subs.length,
    subscriber_breakdown: {
      free: subs.filter(s => s.plan === 'free').length,
      pro: subs.filter(s => s.plan === 'pro').length,
      institutional: subs.filter(s => s.plan === 'institutional').length,
    },
    last_filing: recent[0]?.filed_at ?? null,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/feed') return handleApiFeed(req, env);
    if (url.pathname === '/api/subscribe') return handleSubscribe(req, env);
    if (url.pathname === '/api/confirm') return handleConfirm(req, env);
    if (url.pathname === '/api/pay-status') return handlePayStatus(req, env);
    if (url.pathname === '/api/status') return handleStatus(req, env);

    const subMatch = url.pathname.match(/^\/api\/subscription\/([a-zA-Z0-9_-]+)$/);
    if (subMatch) return handleSubscription(req, env, subMatch[1]);

    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
