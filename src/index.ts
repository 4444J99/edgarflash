/**
 * EdgarFlash — real-time SEC EDGAR filing alerts.
 *
 * Cron polls EDGAR every minute. New Form 4 (insider trades) and 8-K
 * (material events) get pushed to subscribers via webhook.
 *
 * Subscribers added via POST /api/subscribe (plan = "free" | "pro" | "institutional").
 * Free tier: delayed, limited web/API preview.
 * Pro ($99/mo): webhook delivery within 60s of filing.
 * Institutional ($299/mo): API-key access + larger ticker watchlists.
 */

type Plan = 'free' | 'pro' | 'institutional';
type PaidPlan = Exclude<Plan, 'free'>;

interface Env {
  ASSETS: Fetcher;
  EF_STATE: KVNamespace;
  EF_SUBS: KVNamespace;
  USER_AGENT: string;
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
  plan: Plan;
  forms: string[];        // which forms they want; default ["4","8-K"]
  tickers?: string[];     // optional ticker filter
  created_at: string;
  active: boolean;
  activated_at?: string;
  current_period_end?: string;
  api_key_id?: string;
  api_key_hash?: string;
  payment_quote_id?: string;
  payment_tx_hash?: string;
  delivery_count: number;
  last_delivery_at?: string;
}

const FORMS_TO_WATCH = ['4', '8-K'];
const FEED_RECENT_LIMIT = 50;
const FREE_FEED_LIMIT = 10;
const FREE_FEED_DELAY_MINUTES = 15;
const FREE_FEED_DELAY_MS = FREE_FEED_DELAY_MINUTES * 60 * 1000;
const PAID_PERIOD_DAYS = 31;
const STATE_KEY_LAST_FILINGS = 'last_seen_filings';
const FEED_CACHE_KEY = 'feed:recent';
const API_KEY_PREFIX = 'ef_live';

// === payrail (shared fleet money rail) ===
// edgarflash plugs into the live payrail Worker instead of re-implementing
// payment-pending plumbing. payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';
const PRICES: Record<PaidPlan, string> = { pro: '99', institutional: '299' };
const TICKER_LIMITS: Record<Plan, number> = { free: 0, pro: 25, institutional: 100 };
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_EMAIL_LENGTH = 254;
const MAX_WEBHOOK_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 256;
const SAFE_TOKEN_RE = /^[a-zA-Z0-9._:-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
}

type JsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  const record: Record<string, LogValue> = {
    level,
    event,
    ts: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = value;
  }
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message,
    };
  }
  return { error_message: String(err) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonError(error: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ error, ...extra }, { status });
}

function methodNotAllowed(methods: string[]): Response {
  return Response.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: methods.join(', ') } },
  );
}

function isSafeToken(value: string, maxLength = MAX_TOKEN_LENGTH): boolean {
  return value.length > 0 && value.length <= maxLength && SAFE_TOKEN_RE.test(value);
}

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(email);
}

function normalizeRequestId(req: Request): string {
  const incoming = req.headers.get('x-request-id')?.trim() || req.headers.get('cf-ray')?.trim();
  if (incoming && isSafeToken(incoming, 128)) return incoming;
  return newId('req_');
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJsonObject(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonObjectResult> {
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, response: jsonError('payload_too_large', 413) };
    }
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: jsonError('request_body_unreadable', 400) };
  }

  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, response: jsonError('payload_too_large', 413) };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, response: jsonError('invalid JSON', 400) };
  }

  if (!isRecord(value)) return { ok: false, response: jsonError('JSON object required', 400) };
  return { ok: true, value };
}

function normalizeWebhookUrl(input: unknown): ValidationResult<string | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== 'string') return { ok: false, response: jsonError('webhook_url must be a valid HTTPS URL', 400) };

  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
    return { ok: false, response: jsonError('webhook_url must be a valid HTTPS URL', 400) };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return { ok: false, response: jsonError('webhook_url must be a valid HTTPS URL', 400) };
    }
    return { ok: true, value: url.href };
  } catch {
    return { ok: false, response: jsonError('webhook_url must be a valid HTTPS URL', 400) };
  }
}

function normalizeStringArrayField(input: unknown, field: string): ValidationResult<string[] | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(input) || !input.every(item => typeof item === 'string')) {
    return { ok: false, response: jsonError(`${field} must be an array of strings`, 400) };
  }
  return { ok: true, value: input };
}

function normalizePayrailPayTo(input: unknown): PayrailQuote['pay_to'] {
  if (!isRecord(input)) return null;
  const { rail, chain, asset, address, amount } = input;
  if (
    typeof rail !== 'string' ||
    typeof chain !== 'string' ||
    typeof asset !== 'string' ||
    typeof address !== 'string' ||
    typeof amount !== 'string'
  ) {
    return null;
  }
  return { rail, chain, asset, address, amount };
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

async function payrailQuote(env: Env, plan: PaidPlan): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'edgarflash',
    sku: `edgarflash:${plan}`,
    amount: PRICES[plan],
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  const quote: unknown = await r.json();
  if (!isRecord(quote) || typeof quote.quote_id !== 'string' || !isSafeToken(quote.quote_id, 128)) {
    throw new Error('payrail /pay returned invalid quote');
  }
  return {
    quote_id: quote.quote_id,
    pay_to: normalizePayrailPayTo(quote.pay_to),
    checkout: typeof quote.checkout === 'string' ? quote.checkout : null,
    instructions: typeof quote.instructions === 'string' ? quote.instructions : '',
    expires_in_seconds: typeof quote.expires_in_seconds === 'number' ? quote.expires_in_seconds : 0,
  };
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

export function isPaidPlan(plan: Plan): plan is PaidPlan {
  return plan === 'pro' || plan === 'institutional';
}

export function currentPeriodEnd(start = new Date()): string {
  return new Date(start.getTime() + PAID_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function hasPaidAccess(sub: Subscription): boolean {
  if (!sub.active || !isPaidPlan(sub.plan)) return false;
  if (!sub.current_period_end) return true; // legacy active paid subscriptions remain enabled.
  return Date.parse(sub.current_period_end) > Date.now();
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newId(prefix = ''): string {
  return prefix + randomBase64Url(9);
}

function newSecret(): string {
  return randomBase64Url(24);
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueApiKey(env: Env, sub: Subscription): Promise<string> {
  if (sub.api_key_id) await env.EF_SUBS.delete(`api:${sub.api_key_id}`);
  const keyId = newId('ak_');
  const apiKey = `${API_KEY_PREFIX}_${keyId}.${newSecret()}`;
  sub.api_key_id = keyId;
  sub.api_key_hash = await sha256Hex(apiKey);
  await env.EF_SUBS.put(`api:${keyId}`, sub.id);
  return apiKey;
}

export function extractApiKey(req: Request): string | undefined {
  const headerKey = req.headers.get('x-api-key')?.trim();
  if (headerKey) return headerKey;

  const auth = req.headers.get('authorization')?.trim();
  const match = auth?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();

  const queryKey = new URL(req.url).searchParams.get('api_key')?.trim();
  return queryKey || undefined;
}

export function parseApiKey(apiKey: string): { keyId: string } | null {
  const prefix = `${API_KEY_PREFIX}_`;
  if (!apiKey.startsWith(prefix)) return null;
  const rest = apiKey.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { keyId: rest.slice(0, dot) };
}

interface ApiAuthResult {
  presented: boolean;
  sub?: Subscription;
  error?: string;
  status?: number;
}

async function authenticateApiKey(req: Request, env: Env): Promise<ApiAuthResult> {
  const apiKey = extractApiKey(req);
  if (!apiKey) return { presented: false };

  const parsed = parseApiKey(apiKey);
  if (!parsed) return { presented: true, error: 'invalid_api_key', status: 401 };

  const subId = await env.EF_SUBS.get(`api:${parsed.keyId}`);
  if (!subId) return { presented: true, error: 'invalid_api_key', status: 401 };

  const subRaw = await env.EF_SUBS.get(`sub:${subId}`);
  if (!subRaw) return { presented: true, error: 'subscription_not_found', status: 401 };

  let sub: Subscription;
  try { sub = JSON.parse(subRaw) as Subscription; }
  catch { return { presented: true, error: 'subscription_corrupt', status: 500 }; }

  if (!hasPaidAccess(sub)) return { presented: true, error: 'inactive_subscription', status: 403 };
  if (!sub.api_key_hash) return { presented: true, error: 'api_key_not_enabled', status: 403 };

  const digest = await sha256Hex(apiKey);
  if (!timingSafeEqualHex(digest, sub.api_key_hash)) return { presented: true, error: 'invalid_api_key', status: 401 };

  return { presented: true, sub };
}

function apiAuthError(auth: ApiAuthResult, fallback = 'api_key_required'): Response {
  return Response.json({ error: auth.error ?? fallback }, { status: auth.status ?? 401 });
}

export function freeVisibleFilings(filings: Filing[]): Filing[] {
  const cutoff = Date.now() - FREE_FEED_DELAY_MS;
  return filings
    .filter(f => {
      const filedAt = Date.parse(f.filed_at);
      return !Number.isFinite(filedAt) || filedAt <= cutoff;
    })
    .slice(0, FREE_FEED_LIMIT);
}

export function normalizeForms(input: unknown): string[] {
  const requested = Array.isArray(input) ? input.map(String) : FORMS_TO_WATCH;
  const allowed = new Set(FORMS_TO_WATCH);
  const forms = requested.map(f => f.trim()).filter(f => allowed.has(f));
  return [...new Set(forms)];
}

export function normalizeTickers(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(t => String(t).trim().toUpperCase()).filter(Boolean))];
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

export function parseAtomFeed(xml: string, form: string): Filing[] {
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

export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function loadLastSeen(env: Env): Promise<Set<string>> {
  const raw = await env.EF_STATE.get(STATE_KEY_LAST_FILINGS);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('last_seen_filings is not an array');
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch (err) {
    logEvent('warn', 'kv_json_corrupt', { key: STATE_KEY_LAST_FILINGS, ...errorFields(err) });
    return new Set();
  }
}

async function saveLastSeen(env: Env, ids: Set<string>) {
  // Keep recent 1000 IDs to bound memory
  const arr = [...ids].slice(-1000);
  await env.EF_STATE.put(STATE_KEY_LAST_FILINGS, JSON.stringify(arr));
}

async function loadRecentFeed(env: Env): Promise<Filing[]> {
  const raw = await env.EF_STATE.get(FEED_CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('feed:recent is not an array');
    return parsed.filter((filing): filing is Filing => (
      isRecord(filing) &&
      typeof filing.id === 'string' &&
      typeof filing.form === 'string' &&
      typeof filing.filed_at === 'string' &&
      typeof filing.title === 'string' &&
      typeof filing.url === 'string'
    ));
  } catch (err) {
    logEvent('warn', 'kv_json_corrupt', { key: FEED_CACHE_KEY, ...errorFields(err) });
    return [];
  }
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
    try {
      const sub = JSON.parse(v) as Subscription;
      if (!sub.id || !sub.email || !Array.isArray(sub.forms)) throw new Error('invalid subscription shape');
      out.push(sub);
    } catch (err) {
      logEvent('warn', 'kv_json_corrupt', { key: k.name, ...errorFields(err) });
    }
  }
  return out;
}

async function deliverWebhook(sub: Subscription, filings: Filing[], env: Env) {
  if (!sub.webhook_url || !hasPaidAccess(sub)) return;
  const webhook = normalizeWebhookUrl(sub.webhook_url);
  if (!webhook.ok || !webhook.value) {
    logEvent('warn', 'webhook_url_invalid', { subscription_id: sub.id });
    return;
  }

  // Filter
  let toSend = filings.filter(f => sub.forms.includes(f.form));
  if (sub.tickers && sub.tickers.length > 0) {
    toSend = toSend.filter(f => f.company && sub.tickers!.some(t =>
      f.company!.toUpperCase().includes(t.toUpperCase())));
  }
  if (toSend.length === 0) return;

  try {
    const response = await fetch(webhook.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'EdgarFlash/0.1' },
      body: JSON.stringify({ filings: toSend, subscription_id: sub.id }),
    });
    if (!response.ok) {
      logEvent('warn', 'webhook_delivery_failed', {
        subscription_id: sub.id,
        status: response.status,
        filing_count: toSend.length,
      });
      return;
    }
    sub.delivery_count = (sub.delivery_count ?? 0) + 1;
    sub.last_delivery_at = new Date().toISOString();
    await env.EF_SUBS.put(`sub:${sub.id}`, JSON.stringify(sub));
    logEvent('info', 'webhook_delivered', {
      subscription_id: sub.id,
      status: response.status,
      filing_count: toSend.length,
    });
  } catch (err) {
    logEvent('warn', 'webhook_delivery_error', {
      subscription_id: sub.id,
      filing_count: toSend.length,
      ...errorFields(err),
    });
  }
}

async function runCron(env: Env) {
  const startedAt = Date.now();
  const lastSeen = await loadLastSeen(env);
  const newFilings: Filing[] = [];
  for (const form of FORMS_TO_WATCH) {
    let filings: Filing[];
    try { filings = await fetchEdgarFilings(form, env); }
    catch (err) {
      logEvent('warn', 'edgar_fetch_failed', { form, ...errorFields(err) });
      continue;
    }
    for (const f of filings) {
      if (!lastSeen.has(f.id)) {
        newFilings.push(f);
        lastSeen.add(f.id);
      }
    }
  }
  if (newFilings.length === 0) {
    logEvent('info', 'cron_completed', {
      new_filing_count: 0,
      duration_ms: Date.now() - startedAt,
    });
    return;
  }

  // Update feed cache
  const recent = await loadRecentFeed(env);
  const merged = [...newFilings, ...recent].slice(0, FEED_RECENT_LIMIT);
  await saveRecentFeed(env, merged);
  await saveLastSeen(env, lastSeen);

  // Notify subscribers
  const subs = await listSubscriptions(env);
  await Promise.all(subs.map(s => deliverWebhook(s, newFilings, env)));
  logEvent('info', 'cron_completed', {
    new_filing_count: newFilings.length,
    subscriber_count: subs.length,
    duration_ms: Date.now() - startedAt,
  });
}

// === HTTP handlers ===

async function handleApiFeed(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const auth = await authenticateApiKey(req, env);
  if (auth.presented && !auth.sub) {
    logEvent('warn', 'api_auth_failed', {
      request_id: ctx.requestId,
      path: ctx.path,
      reason: auth.error ?? 'api_key_required',
      status: auth.status ?? 401,
    });
    return apiAuthError(auth);
  }

  const filings = await loadRecentFeed(env);
  if (auth.sub) {
    return Response.json({
      tier: auth.sub.plan,
      realtime: true,
      subscription_id: auth.sub.id,
      count: filings.length,
      filings,
      updated_at: new Date().toISOString(),
      note: 'Paid API-key feed — real-time SEC alert cache.',
    });
  }

  const delayed = freeVisibleFilings(filings);
  return Response.json({
    tier: 'free',
    realtime: false,
    delayed_minutes: FREE_FEED_DELAY_MINUTES,
    limit: FREE_FEED_LIMIT,
    count: delayed.length,
    total_cached: filings.length,
    filings: delayed,
    updated_at: new Date().toISOString(),
    note: 'Free tier is delayed and limited. Subscribe to Pro or Institutional for an API key and real-time alerts.',
  });
}

async function handleRealtimeFeed(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const auth = await authenticateApiKey(req, env);
  if (!auth.sub) {
    logEvent('warn', 'api_auth_failed', {
      request_id: ctx.requestId,
      path: ctx.path,
      reason: auth.error ?? 'api_key_required',
      status: auth.status ?? 401,
    });
    return apiAuthError(auth);
  }

  const filings = await loadRecentFeed(env);
  return Response.json({
    tier: auth.sub.plan,
    realtime: true,
    subscription_id: auth.sub.id,
    count: filings.length,
    filings,
    updated_at: new Date().toISOString(),
  });
}

async function handleSubscribe(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.value;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const webhookResult = normalizeWebhookUrl(body.webhook_url);
  if (!webhookResult.ok) return webhookResult.response;

  const requestedPlan = body.plan ?? 'free';
  if (typeof requestedPlan !== 'string') {
    return jsonError('plan must be one of: free, pro, institutional', 400);
  }
  if (requestedPlan !== 'free' && requestedPlan !== 'pro' && requestedPlan !== 'institutional') {
    return jsonError('plan must be one of: free, pro, institutional', 400);
  }

  const formsResult = normalizeStringArrayField(body.forms, 'forms');
  if (!formsResult.ok) return formsResult.response;
  const tickersResult = normalizeStringArrayField(body.tickers, 'tickers');
  if (!tickersResult.ok) return tickersResult.response;

  const plan: Plan = requestedPlan;
  const webhook_url = webhookResult.value;
  const forms = normalizeForms(formsResult.value);
  const tickersInput = normalizeTickers(tickersResult.value);
  const tickerLimit = TICKER_LIMITS[plan];

  if (!isValidEmail(email)) return jsonError('valid email required', 400);
  if (forms.length === 0) return jsonError(`forms must include one of: ${FORMS_TO_WATCH.join(', ')}`, 400);
  if (tickersInput.some(ticker => !TICKER_RE.test(ticker))) {
    return jsonError('tickers must be 1-12 characters using letters, numbers, dot, or hyphen', 400);
  }
  if (tickersInput.length > tickerLimit) {
    return jsonError(`${plan} plan allows up to ${tickerLimit} ticker filters`, 400);
  }
  if (isPaidPlan(plan) && !webhook_url) {
    return jsonError('paid plans require webhook_url', 400);
  }

  const id = newId('s_');
  const sub: Subscription = {
    id,
    email,
    webhook_url: isPaidPlan(plan) ? webhook_url : undefined,
    plan,
    forms,
    tickers: tickersInput.length > 0 ? tickersInput : undefined,
    created_at: new Date().toISOString(),
    active: plan === 'free',  // paid plans wait for payment confirmation
    delivery_count: 0,
  };
  await env.EF_SUBS.put(`sub:${id}`, JSON.stringify(sub));
  logEvent('info', 'subscription_created', {
    request_id: ctx.requestId,
    subscription_id: id,
    plan,
    active: sub.active,
    form_count: forms.length,
    ticker_count: tickersInput.length,
  });

  if (plan === 'free') {
    return Response.json({
      subscription_id: id,
      status: 'active',
      plan,
      ticker_limit: tickerLimit,
      message: `Free tier active. /api/feed is delayed ${FREE_FEED_DELAY_MINUTES} minutes and limited to ${FREE_FEED_LIMIT} filings.`,
    });
  }

  // Paid plan: get a live quote from the shared payrail rail and return a 402
  // carrying the on-chain address + memo (quote_id). The subscription is already
  // persisted with active=false; the buyer pays, then POSTs the tx hash to
  // /api/confirm to unlock. No payment-pending stub.
  const paidPlan = plan;
  let q: PayrailQuote;
  try {
    q = await payrailQuote(env, paidPlan);
  } catch (err) {
    await env.EF_SUBS.delete(`sub:${id}`);
    logEvent('error', 'payrail_quote_failed', {
      request_id: ctx.requestId,
      subscription_id: id,
      plan: paidPlan,
      ...errorFields(err),
    });
    return jsonError('rail_unavailable', 502);
  }
  await env.EF_SUBS.put(
    `pending:${q.quote_id}`,
    JSON.stringify({ quote_id: q.quote_id, subscription_id: id, plan: paidPlan }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
  return Response.json({
    status: 'payment_required',
    plan: paidPlan,
    amount_usd: PRICES[paidPlan],
    ticker_limit: tickerLimit,
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
// flip the pending sub to active, then issue the real-time API key.
async function handleConfirm(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed(['POST']);
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const quoteId = typeof parsed.value.quote_id === 'string' ? parsed.value.quote_id.trim() : '';
  const txHash = typeof parsed.value.tx_hash === 'string' ? parsed.value.tx_hash.trim() : '';
  if (!quoteId || !txHash) {
    return jsonError('quote_id and tx_hash required', 400);
  }
  if (!isSafeToken(quoteId, 128) || !isSafeToken(txHash, MAX_TOKEN_LENGTH)) {
    return jsonError('quote_id and tx_hash must be safe tokens', 400);
  }

  const pendingRaw = await env.EF_SUBS.get(`pending:${quoteId}`);
  if (!pendingRaw) return jsonError('quote_not_found_or_expired', 404);

  let pending: { quote_id: string; subscription_id: string; plan: PaidPlan };
  try {
    const parsedPending = JSON.parse(pendingRaw);
    if (
      !isRecord(parsedPending) ||
      typeof parsedPending.subscription_id !== 'string' ||
      !isSafeToken(parsedPending.subscription_id, 128) ||
      (parsedPending.plan !== 'pro' && parsedPending.plan !== 'institutional')
    ) {
      throw new Error('invalid pending subscription shape');
    }
    pending = {
      quote_id: quoteId,
      subscription_id: parsedPending.subscription_id,
      plan: parsedPending.plan,
    };
  } catch (err) {
    logEvent('error', 'pending_subscription_corrupt', {
      request_id: ctx.requestId,
      quote_id: quoteId,
      ...errorFields(err),
    });
    return jsonError('pending_subscription_corrupt', 500);
  }
  const plan: PaidPlan = pending.plan === 'institutional' ? 'institutional' : 'pro';

  const payload = JSON.stringify({
    quote_id: quoteId,
    ship: 'edgarflash',
    sku: `edgarflash:${plan}`,
    amount: PRICES[plan],
    currency: 'USDC',
    rail: 'crypto',
    tx_hash: txHash,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.SHIP_HMAC_SECRET) headers['x-payrail-signature'] = await hmacHex(env.SHIP_HMAC_SECRET, payload);

  let rr: Response;
  try {
    rr = await payrailFetch(env, '/receipt', { method: 'POST', headers, body: payload });
  } catch (err) {
    logEvent('error', 'payrail_receipt_error', {
      request_id: ctx.requestId,
      quote_id: quoteId,
      subscription_id: pending.subscription_id,
      ...errorFields(err),
    });
    return jsonError('receipt_unavailable', 502);
  }
  if (!rr.ok) {
    const detail = await rr.text().catch(() => '');
    logEvent('warn', 'payrail_receipt_rejected', {
      request_id: ctx.requestId,
      quote_id: quoteId,
      subscription_id: pending.subscription_id,
      status: rr.status,
      detail: detail.slice(0, 200),
    });
    return Response.json(
      { error: 'receipt_rejected', status: rr.status },
      { status: 502 },
    );
  }

  const subRaw = await env.EF_SUBS.get(`sub:${pending.subscription_id}`);
  if (!subRaw) return jsonError('subscription_not_found', 404);

  let sub: Subscription;
  try {
    sub = JSON.parse(subRaw) as Subscription;
  } catch (err) {
    logEvent('error', 'subscription_json_corrupt', {
      request_id: ctx.requestId,
      subscription_id: pending.subscription_id,
      ...errorFields(err),
    });
    return jsonError('subscription_corrupt', 500);
  }
  sub.active = true;
  sub.activated_at = new Date().toISOString();
  sub.current_period_end = currentPeriodEnd();
  sub.payment_quote_id = quoteId;
  sub.payment_tx_hash = txHash;
  const apiKey = sub.api_key_hash && sub.api_key_id ? undefined : await issueApiKey(env, sub);
  await env.EF_SUBS.put(`sub:${pending.subscription_id}`, JSON.stringify(sub));
  await env.EF_SUBS.delete(`pending:${quoteId}`);
  logEvent('info', 'subscription_activated', {
    request_id: ctx.requestId,
    subscription_id: pending.subscription_id,
    quote_id: quoteId,
    plan: sub.plan,
    api_key_issued: Boolean(apiKey),
  });
  return Response.json({
    status: 'active',
    subscription_id: pending.subscription_id,
    plan: sub.plan,
    current_period_end: sub.current_period_end,
    api_key: apiKey,
    api_key_id: sub.api_key_id,
    api_key_note: apiKey ? 'Store this key now; it is only returned on activation.' : 'API key was already issued.',
    realtime_feed_url: '/api/feed',
    realtime_endpoint: '/api/realtime',
  });
}

// Poll payment status by proxying payrail's public receipt lookup.
async function handlePayStatus(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  const url = new URL(req.url);
  const quoteId = url.searchParams.get('quote_id')?.trim() ?? '';
  if (!quoteId) return jsonError('quote_id required', 400);
  if (!isSafeToken(quoteId, 128)) return jsonError('quote_id must be a safe token', 400);

  let r: Response;
  try {
    r = await payrailFetch(env, `/receipt/${encodeURIComponent(quoteId)}`);
  } catch (err) {
    logEvent('error', 'payrail_status_error', {
      request_id: ctx.requestId,
      quote_id: quoteId,
      ...errorFields(err),
    });
    return jsonError('status_unavailable', 502);
  }

  if (r.status === 404) return Response.json({ paid: false, quote_id: quoteId });
  if (!r.ok) return Response.json({ error: 'status_unavailable', status: r.status }, { status: 502 });

  try {
    return Response.json({ paid: true, receipt: await r.json() });
  } catch (err) {
    logEvent('error', 'payrail_status_invalid_json', {
      request_id: ctx.requestId,
      quote_id: quoteId,
      ...errorFields(err),
    });
    return jsonError('status_unavailable', 502);
  }
}

async function handleSubscription(req: Request, env: Env, id: string, ctx: RequestContext): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
  if (!isSafeToken(id, 128)) return jsonError('not found', 404);
  const v = await env.EF_SUBS.get(`sub:${id}`);
  if (!v) return jsonError('not found', 404);

  let sub: Subscription;
  try {
    sub = JSON.parse(v) as Subscription;
  } catch (err) {
    logEvent('error', 'subscription_json_corrupt', {
      request_id: ctx.requestId,
      subscription_id: id,
      ...errorFields(err),
    });
    return jsonError('subscription_corrupt', 500);
  }
  // Don't return webhook_url in public response
  return Response.json({
    id: sub.id,
    plan: sub.plan,
    active: sub.active,
    realtime_api: hasPaidAccess(sub),
    api_key_id: sub.api_key_id,
    forms: sub.forms,
    tickers: sub.tickers,
    delivery_count: sub.delivery_count,
    last_delivery_at: sub.last_delivery_at,
    created_at: sub.created_at,
    activated_at: sub.activated_at,
    current_period_end: sub.current_period_end,
  });
}

async function handleStatus(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(['GET']);
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
    active_paid_subscriber_count: subs.filter(hasPaidAccess).length,
    free_feed: {
      delayed_minutes: FREE_FEED_DELAY_MINUTES,
      limit: FREE_FEED_LIMIT,
    },
    plan_limits: {
      ticker_filters: TICKER_LIMITS,
    },
    last_filing: recent[0]?.filed_at ?? null,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(req.url);
    const ctx: RequestContext = {
      requestId: normalizeRequestId(req),
      method: req.method,
      path: url.pathname,
    };

    try {
      let response: Response;
      if (url.pathname === '/api/feed') response = await handleApiFeed(req, env, ctx);
      else if (url.pathname === '/api/realtime') response = await handleRealtimeFeed(req, env, ctx);
      else if (url.pathname === '/api/subscribe') response = await handleSubscribe(req, env, ctx);
      else if (url.pathname === '/api/confirm') response = await handleConfirm(req, env, ctx);
      else if (url.pathname === '/api/pay-status') response = await handlePayStatus(req, env, ctx);
      else if (url.pathname === '/api/status') response = await handleStatus(req, env);
      else {
        const subMatch = url.pathname.match(/^\/api\/subscription\/([a-zA-Z0-9_-]+)$/);
        response = subMatch ? await handleSubscription(req, env, subMatch[1], ctx) : await env.ASSETS.fetch(req);
      }

      logEvent('info', 'request_completed', {
        request_id: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(response, ctx.requestId);
    } catch (err) {
      logEvent('error', 'request_failed', {
        request_id: ctx.requestId,
        method: ctx.method,
        path: ctx.path,
        duration_ms: Date.now() - startedAt,
        ...errorFields(err),
      });
      const response = ctx.path.startsWith('/api/')
        ? Response.json({ error: 'internal_error', request_id: ctx.requestId }, { status: 500 })
        : new Response('internal error', { status: 500 });
      return withRequestId(response, ctx.requestId);
    }
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env).catch(err => {
      logEvent('error', 'scheduled_failed', errorFields(err));
    }));
  },
};
