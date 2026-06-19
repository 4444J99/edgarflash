import { describe, it, expect } from 'vitest';
import {
  isPaidPlan,
  currentPeriodEnd,
  hasPaidAccess,
  sha256Hex,
  timingSafeEqualHex,
  extractApiKey,
  parseApiKey,
  freeVisibleFilings,
  normalizeForms,
  normalizeTickers,
  parseAtomFeed,
  stripHtml,
} from '../src/index';

describe('plan helpers', () => {
  it('isPaidPlan distinguishes free from paid', () => {
    expect(isPaidPlan('free')).toBe(false);
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('institutional')).toBe(true);
  });

  it('currentPeriodEnd is 31 days after the start', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(currentPeriodEnd(start)).toBe('2026-02-01T00:00:00.000Z');
  });

  it('hasPaidAccess gates on active + paid + period', () => {
    const base = {
      id: 's1', email: 'a@b.c', plan: 'pro' as const, forms: ['4'],
      created_at: '2026-01-01T00:00:00.000Z', active: true, delivery_count: 0,
    };
    const future = new Date('2999-01-01T00:00:00.000Z').toISOString();
    const past = new Date('2000-01-01T00:00:00.000Z').toISOString();

    expect(hasPaidAccess({ ...base, current_period_end: future })).toBe(true);
    expect(hasPaidAccess({ ...base, current_period_end: past })).toBe(false);
    expect(hasPaidAccess({ ...base, active: false, current_period_end: future })).toBe(false);
    expect(hasPaidAccess({ ...base, plan: 'free', current_period_end: future })).toBe(false);
    // Legacy active paid subs with no period stay enabled.
    expect(hasPaidAccess(base)).toBe(true);
  });
});

describe('crypto helpers', () => {
  it('sha256Hex is deterministic 64-char hex', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('world')).not.toBe(a);
  });

  it('timingSafeEqualHex compares by value and length', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
  });
});

describe('api key parsing', () => {
  it('extractApiKey reads x-api-key, bearer, then query', () => {
    expect(extractApiKey(new Request('https://x/', { headers: { 'x-api-key': 'k1' } }))).toBe('k1');
    expect(extractApiKey(new Request('https://x/', { headers: { authorization: 'Bearer k2' } }))).toBe('k2');
    expect(extractApiKey(new Request('https://x/?api_key=k3'))).toBe('k3');
    expect(extractApiKey(new Request('https://x/'))).toBeUndefined();
  });

  it('parseApiKey validates the ef_live_<id>.<secret> shape', () => {
    expect(parseApiKey('ef_live_ak_123.secretpart')).toEqual({ keyId: 'ak_123' });
    expect(parseApiKey('wrong_prefix.secret')).toBeNull();
    expect(parseApiKey('ef_live_nodot')).toBeNull();
    expect(parseApiKey('ef_live_.secret')).toBeNull();
    expect(parseApiKey('ef_live_id.')).toBeNull();
  });
});

describe('input normalization', () => {
  it('normalizeForms filters to watched forms and dedupes', () => {
    expect(normalizeForms(['4', '4', '10-K', '8-K'])).toEqual(['4', '8-K']);
    expect(normalizeForms('not-an-array')).toEqual(['4', '8-K']); // default
    expect(normalizeForms(['10-Q'])).toEqual([]);
  });

  it('normalizeTickers upper-cases, trims, dedupes, drops empties', () => {
    expect(normalizeTickers([' aapl ', 'AAPL', 'msft', ''])).toEqual(['AAPL', 'MSFT']);
    expect(normalizeTickers('nope')).toEqual([]);
  });
});

describe('free feed visibility', () => {
  const mk = (id: string, filedAt: string) => ({
    id, form: '4', filed_at: filedAt, title: id, url: `https://x/${id}`,
  });

  it('hides filings newer than the delay and caps the count', () => {
    const old = Array.from({ length: 12 }, (_, i) => mk(`old${i}`, '2020-01-01T00:00:00.000Z'));
    const fresh = mk('fresh', new Date().toISOString());
    const visible = freeVisibleFilings([fresh, ...old]);

    expect(visible.length).toBe(10); // FREE_FEED_LIMIT
    expect(visible.some(f => f.id === 'fresh')).toBe(false);
  });

  it('includes filings with an unparseable timestamp', () => {
    const visible = freeVisibleFilings([mk('weird', 'not-a-date')]);
    expect(visible.map(f => f.id)).toEqual(['weird']);
  });
});

describe('atom parsing', () => {
  it('stripHtml removes tags and collapses whitespace', () => {
    expect(stripHtml('<b>Form&nbsp;4</b>   filed\n')).toBe('Form 4 filed');
  });

  it('parseAtomFeed extracts company, cik, link and id from an entry', () => {
    const xml = `<feed>
      <entry>
        <title>4 - SMITH JOHN (1234567) (Reporting)</title>
        <link rel="alternate" type="text/html" href="https://www.sec.gov/abc"/>
        <updated>2026-06-01T12:00:00-04:00</updated>
        <id>urn:tag:sec.gov,2008:accession-number=1</id>
        <summary type="html">Form 4 filed</summary>
      </entry>
    </feed>`;

    const filings = parseAtomFeed(xml, '4');
    expect(filings).toHaveLength(1);
    const f = filings[0];
    expect(f.form).toBe('4');
    expect(f.company).toBe('SMITH JOHN');
    expect(f.cik).toBe('1234567');
    expect(f.url).toBe('https://www.sec.gov/abc');
    expect(f.id).toBe('urn:tag:sec.gov,2008:accession-number=1');
    expect(f.filed_at).toBe('2026-06-01T12:00:00-04:00');
    expect(f.summary).toContain('Form 4');
  });

  it('parseAtomFeed skips entries missing required fields', () => {
    const xml = `<feed><entry><title>only a title</title></entry></feed>`;
    expect(parseAtomFeed(xml, '4')).toHaveLength(0);
  });
});
