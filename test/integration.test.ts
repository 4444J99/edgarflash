import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

describe('EdgarFlash Integration Tests', () => {
  it('should run the main user flow end-to-end', async () => {
    // 1. Initial status
    let response = await SELF.fetch('https://example.com/api/status');
    expect(response.status).toBe(200);
    let data: any = await response.json();
    expect(data.name).toBe('EdgarFlash');
    expect(data.subscriber_count).toBe(0);

    // 2. Subscribe
    response = await SELF.fetch('https://example.com/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e-test@example.com',
        plan: 'free',
        forms: ['4', '8-K']
      })
    });
    expect(response.status).toBe(200);
    data = await response.json();
    expect(data.status).toBe('active');
    expect(data.plan).toBe('free');
    const subscriptionId = data.subscription_id;

    // 3. Status should reflect new subscription
    response = await SELF.fetch('https://example.com/api/status');
    expect(response.status).toBe(200);
    data = await response.json();
    expect(data.subscriber_count).toBe(1);
    expect(data.subscriber_breakdown.free).toBe(1);

    // 4. Fetch subscription details
    response = await SELF.fetch(`https://example.com/api/subscription/${subscriptionId}`);
    expect(response.status).toBe(200);
    data = await response.json();
    expect(data.id).toBe(subscriptionId);
    expect(data.plan).toBe('free');
    expect(data.active).toBe(true);

    // 5. Feed should be empty
    response = await SELF.fetch('https://example.com/api/feed');
    expect(response.status).toBe(200);
    data = await response.json();
    expect(data.count).toBe(0);
  });
  
  it('should run cron successfully (no throws)', async () => {
    const ctx = createExecutionContext();
    // Use worker directly instead of SELF to call scheduled
    await worker.scheduled(null as any, env as any, ctx);
    await waitOnExecutionContext(ctx);
    
    // We won't verify actual filings fetched since SEC EDGAR can be slow or return empty 
    // depending on time of day, but we ensure it doesn't crash.
    const res = await SELF.fetch('https://example.com/api/status');
    expect(res.status).toBe(200);
  }, 15000); // give it more time for fetch
});
