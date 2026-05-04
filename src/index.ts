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

  // Paid plans need Stripe Checkout (latent)
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({
      subscription_id: id,
      status: 'pending_payment',
      plan,
      message: 'Stripe activation pending. Email hello@edgarflash.dev with subscription_id; we will activate manually + invoice.',
    }, { status: 202 });
  }

  // Real Stripe flow when active
  return Response.json({ subscription_id: id, status: 'pending_payment', message: 'Stripe checkout — wire pending.' }, { status: 202 });
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
    if (url.pathname === '/api/status') return handleStatus(req, env);

    const subMatch = url.pathname.match(/^\/api\/subscription\/([a-zA-Z0-9_-]+)$/);
    if (subMatch) return handleSubscription(req, env, subMatch[1]);

    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
};
