# EdgarFlash API Guide

Customer-facing reference for integrating EdgarFlash real-time SEC EDGAR filing
alerts into trading systems, research workflows, dashboards, and alerting
pipelines.

Base URL:

```text
https://edgarflash.ivixivi.workers.dev
```

Local development uses the host printed by `npm run dev`.

## Quick Start

1. Create a paid subscription with `POST /api/subscribe`.
2. Pay the returned quote using the `pay_to`, `checkout`, and `instructions`
   fields.
3. Confirm the payment with `POST /api/confirm`.
4. Store the returned `api_key`. It is only returned during activation.
5. Call `GET /api/realtime` or authenticated `GET /api/feed` with the key.

```bash
curl -H "Authorization: Bearer $EDGARFLASH_API_KEY" \
  https://edgarflash.ivixivi.workers.dev/api/realtime
```

## Plans

| Plan | Price | API access | Webhook delivery | Ticker filters |
| --- | ---: | --- | --- | ---: |
| Free | $0 | Delayed `/api/feed` preview | No | 0 |
| Pro | $99/mo | Real-time API key | Yes | 25 |
| Institutional | $299/mo | Real-time API key | Yes | 100 |

Paid access is issued for a 31-day period after payment confirmation. The free
feed is delayed by 15 minutes and limited to the latest 10 visible filings.
Paid feeds return the real-time alert cache, currently capped at 50 filings.

## Authentication

Paid endpoints require an EdgarFlash API key. Keys look like this:

```text
ef_live_ak_...<key id>.<secret>
```

Treat the full value as opaque. Do not parse it or store only the key id.

Send the key with either header:

```http
Authorization: Bearer <api_key>
```

```http
x-api-key: <api_key>
```

`Authorization: Bearer` is recommended. `api_key=<api_key>` in the query string
is accepted for compatibility, but avoid it in production because URLs are often
logged by clients, proxies, and analytics tools.

API keys are only returned by `POST /api/confirm` when a paid subscription is
activated. EdgarFlash stores the key id and a hash of the secret, not the secret
itself, so lost keys cannot be retrieved.

Common authentication errors:

| Status | Error | Meaning |
| ---: | --- | --- |
| 401 | `api_key_required` | No API key was supplied to a paid-only route. |
| 401 | `invalid_api_key` | The key format, id, or secret is invalid. |
| 401 | `subscription_not_found` | The key id points to a missing subscription. |
| 403 | `inactive_subscription` | The subscription is not active or the paid period expired. |
| 403 | `api_key_not_enabled` | The subscription does not have an API key enabled. |

## Conventions

All API responses are JSON except method errors, which may return plain text.
Send JSON request bodies with:

```http
Content-Type: application/json
```

Timestamps are ISO 8601 strings. Error responses use:

```json
{ "error": "machine_readable_error" }
```

## Filing Object

Feed and webhook responses contain `filings` arrays. Each filing may include:

```json
{
  "id": "filing-8k-1",
  "form": "8-K",
  "company": "ACME HOLDINGS INC",
  "cik": "0001234567",
  "filed_at": "2026-06-19T10:01:00Z",
  "title": "8-K - ACME HOLDINGS INC (0001234567) (Filer)",
  "url": "https://www.sec.gov/Archives/edgar/data/1234567/8-k.html",
  "summary": "Material event filed"
}
```

Fields such as `company`, `cik`, `ticker`, and `summary` are optional because
they depend on what EDGAR publishes in each Atom entry.

## Endpoint Summary

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/feed` | Optional | Delayed public feed, or real-time feed when an API key is supplied. |
| `GET` | `/api/realtime` | Paid key | Paid real-time filing feed. |
| `POST` | `/api/subscribe` | None | Create a free subscription or paid checkout. |
| `POST` | `/api/confirm` | None | Confirm a paid quote and receive the one-time API key. |
| `GET` | `/api/pay-status?quote_id=...` | None | Check whether a payment quote has a recorded receipt. |
| `GET` | `/api/subscription/:id` | None | Read safe subscription status. |
| `GET` | `/api/status` | None | Read public system health and plan limits. |

## GET /api/feed

Returns the public delayed feed when called without an API key. If a valid paid
API key is supplied, it returns the same real-time cache as `/api/realtime`.

Public request:

```bash
curl https://edgarflash.ivixivi.workers.dev/api/feed
```

Public response:

```json
{
  "tier": "free",
  "realtime": false,
  "delayed_minutes": 15,
  "limit": 10,
  "count": 1,
  "total_cached": 13,
  "filings": [
    {
      "id": "filing-4-1",
      "form": "4",
      "company": "ACME HOLDINGS INC",
      "cik": "0001234567",
      "filed_at": "2026-06-19T10:00:00Z",
      "title": "4 - ACME HOLDINGS INC (0001234567) (Filer)",
      "url": "https://www.sec.gov/Archives/edgar/data/1234567/4.html"
    }
  ],
  "updated_at": "2026-06-20T14:30:00.000Z",
  "note": "Free tier is delayed and limited. Subscribe to Pro or Institutional for an API key and real-time alerts."
}
```

Authenticated request:

```bash
curl -H "Authorization: Bearer $EDGARFLASH_API_KEY" \
  https://edgarflash.ivixivi.workers.dev/api/feed
```

Authenticated response:

```json
{
  "tier": "pro",
  "realtime": true,
  "subscription_id": "s_abc123",
  "count": 0,
  "filings": [],
  "updated_at": "2026-06-20T14:30:00.000Z",
  "note": "Paid API-key feed - real-time SEC alert cache."
}
```

## GET /api/realtime

Returns the paid real-time filing cache. This endpoint always requires a valid
paid API key.

```bash
curl -H "x-api-key: $EDGARFLASH_API_KEY" \
  https://edgarflash.ivixivi.workers.dev/api/realtime
```

Response:

```json
{
  "tier": "institutional",
  "realtime": true,
  "subscription_id": "s_abc123",
  "count": 0,
  "filings": [],
  "updated_at": "2026-06-20T14:30:00.000Z"
}
```

## POST /api/subscribe

Creates a subscription record. Free subscriptions activate immediately. Paid
plans return a payment quote with HTTP `402 Payment Required`.

Request fields:

| Field | Required | Description |
| --- | --- | --- |
| `email` | Yes | Customer email. It is normalized to lowercase. |
| `plan` | No | `free`, `pro`, or `institutional`. Defaults to `free`. |
| `webhook_url` | Paid only | Endpoint URL for paid webhook delivery. HTTPS is recommended. |
| `forms` | No | Array containing `4`, `8-K`, or both. Defaults to both. |
| `tickers` | No | Array of uppercase or lowercase filter terms. Duplicates are removed. |

Ticker filter limits are 0 for Free, 25 for Pro, and 100 for Institutional.
Filters are applied to the company text extracted from EDGAR feed titles.

Free request:

```bash
curl -X POST https://edgarflash.ivixivi.workers.dev/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "email": "research@example.com",
    "plan": "free",
    "forms": ["4", "8-K"]
  }'
```

Free response:

```json
{
  "subscription_id": "s_abc123",
  "status": "active",
  "plan": "free",
  "ticker_limit": 0,
  "message": "Free tier active. /api/feed is delayed 15 minutes and limited to 10 filings."
}
```

Paid request:

```bash
curl -i -X POST https://edgarflash.ivixivi.workers.dev/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alerts@example.com",
    "plan": "pro",
    "webhook_url": "https://example.com/webhooks/edgarflash",
    "forms": ["4", "8-K"],
    "tickers": ["AAPL", "MSFT"]
  }'
```

Paid response:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
```

```json
{
  "status": "payment_required",
  "plan": "pro",
  "amount_usd": "99",
  "ticker_limit": 25,
  "subscription_id": "s_abc123",
  "quote_id": "quote_pro_1",
  "pay_to": {
    "rail": "crypto",
    "chain": "base",
    "asset": "USDC",
    "address": "0xabc",
    "amount": "99"
  },
  "checkout": "https://pay.example/quote_pro_1",
  "instructions": "pay with memo quote_pro_1",
  "expires_in_seconds": 900,
  "confirm_url": "/api/confirm"
}
```

Validation errors:

| Status | Error |
| ---: | --- |
| 400 | `invalid JSON` |
| 400 | `valid email required` |
| 400 | `forms must include one of: 4, 8-K` |
| 400 | `<plan> plan allows up to <n> ticker filters` |
| 400 | `paid plans require webhook_url` |
| 405 | Plain-text `method not allowed` |
| 502 | `rail_unavailable` |

## POST /api/confirm

Confirms a paid quote after payment and activates the subscription. The returned
API key is shown only once.

Request:

```bash
curl -X POST https://edgarflash.ivixivi.workers.dev/api/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "quote_id": "quote_pro_1",
    "tx_hash": "0xpaid"
  }'
```

Response:

```json
{
  "status": "active",
  "subscription_id": "s_abc123",
  "plan": "pro",
  "current_period_end": "2026-07-21T14:30:00.000Z",
  "api_key": "ef_live_ak_abc.secret",
  "api_key_id": "ak_abc",
  "api_key_note": "Store this key now; it is only returned on activation.",
  "realtime_feed_url": "/api/feed",
  "realtime_endpoint": "/api/realtime"
}
```

If the subscription was already activated, the response may omit `api_key` and
return:

```json
{
  "api_key_note": "API key was already issued."
}
```

Errors:

| Status | Error |
| ---: | --- |
| 400 | `quote_id and tx_hash required` |
| 404 | `quote_not_found_or_expired` |
| 404 | `subscription_not_found` |
| 405 | Plain-text `POST only` |
| 502 | `receipt_rejected` |

## GET /api/pay-status

Checks the payment status for a quote id by looking up its receipt.

Request:

```bash
curl "https://edgarflash.ivixivi.workers.dev/api/pay-status?quote_id=quote_pro_1"
```

Unpaid response:

```json
{
  "paid": false,
  "quote_id": "quote_pro_1"
}
```

Paid response:

```json
{
  "paid": true,
  "receipt": {
    "quote_id": "quote_pro_1",
    "payer_ref": "0xpaid"
  }
}
```

Errors:

| Status | Error |
| ---: | --- |
| 400 | `quote_id required` |
| 502 | `status_unavailable` |

## GET /api/subscription/:id

Returns safe subscription metadata without exposing the webhook URL, payment
transaction hash, or API key hash.

```bash
curl https://edgarflash.ivixivi.workers.dev/api/subscription/s_abc123
```

Response:

```json
{
  "id": "s_abc123",
  "plan": "pro",
  "active": true,
  "realtime_api": true,
  "api_key_id": "ak_abc",
  "forms": ["4", "8-K"],
  "tickers": ["AAPL", "MSFT"],
  "delivery_count": 12,
  "last_delivery_at": "2026-06-20T14:29:00.000Z",
  "created_at": "2026-06-20T14:00:00.000Z",
  "activated_at": "2026-06-20T14:30:00.000Z",
  "current_period_end": "2026-07-21T14:30:00.000Z"
}
```

Missing subscriptions return:

```json
{ "error": "not found" }
```

with HTTP `404`.

## GET /api/status

Returns public service health and plan limits.

```bash
curl https://edgarflash.ivixivi.workers.dev/api/status
```

Response:

```json
{
  "name": "EdgarFlash",
  "feed_size": 2,
  "subscriber_count": 25,
  "subscriber_breakdown": {
    "free": 10,
    "pro": 12,
    "institutional": 3
  },
  "active_paid_subscriber_count": 15,
  "free_feed": {
    "delayed_minutes": 15,
    "limit": 10
  },
  "plan_limits": {
    "ticker_filters": {
      "free": 0,
      "pro": 25,
      "institutional": 100
    }
  },
  "last_filing": "2026-06-19T10:00:00Z"
}
```

## Webhook Delivery

Paid subscriptions require `webhook_url`. When new filings match the
subscription's forms and filters, EdgarFlash sends:

```http
POST <webhook_url>
Content-Type: application/json
User-Agent: EdgarFlash/0.1
```

Payload:

```json
{
  "subscription_id": "s_abc123",
  "filings": [
    {
      "id": "filing-4-1",
      "form": "4",
      "company": "ACME HOLDINGS INC",
      "cik": "0001234567",
      "filed_at": "2026-06-19T10:00:00Z",
      "title": "4 - ACME HOLDINGS INC (0001234567) (Filer)",
      "url": "https://www.sec.gov/Archives/edgar/data/1234567/4.html",
      "summary": "Owner transaction filed"
    }
  ]
}
```

Webhook handling guidance:

- Return a `2xx` status quickly.
- Make your endpoint idempotent by using each filing's `id`.
- Keep the webhook URL secret or put your own authentication token in the URL,
  because EdgarFlash does not currently sign webhook payloads.
- Store the original `url` to preserve a direct link to the SEC filing.

## Integration Examples

Node.js:

```js
const apiKey = process.env.EDGARFLASH_API_KEY;

const response = await fetch('https://edgarflash.ivixivi.workers.dev/api/realtime', {
  headers: {
    Authorization: `Bearer ${apiKey}`,
  },
});

if (!response.ok) {
  throw new Error(`EdgarFlash ${response.status}: ${await response.text()}`);
}

const feed = await response.json();
for (const filing of feed.filings) {
  console.log(filing.form, filing.company, filing.filed_at, filing.url);
}
```

Python:

```python
import os
import requests

response = requests.get(
    "https://edgarflash.ivixivi.workers.dev/api/realtime",
    headers={"Authorization": f"Bearer {os.environ['EDGARFLASH_API_KEY']}"},
    timeout=10,
)
response.raise_for_status()

for filing in response.json()["filings"]:
    print(filing["form"], filing.get("company"), filing["filed_at"], filing["url"])
```

Webhook receiver example:

```js
import express from 'express';

const app = express();
app.use(express.json());

app.post('/webhooks/edgarflash', (req, res) => {
  for (const filing of req.body.filings ?? []) {
    // Use filing.id for idempotency before forwarding to queues or alerts.
    console.log(filing.id, filing.form, filing.url);
  }

  res.json({ ok: true });
});

app.listen(3000);
```

## Operational Notes

- EdgarFlash watches SEC EDGAR Form 4 and 8-K Atom feeds.
- The Worker polling schedule is every minute.
- Paid API responses are a real-time cache of recently observed filings, not a
  streaming connection.
- Free responses hide filings newer than 15 minutes.
- Unknown `plan` values in `POST /api/subscribe` are treated as `free`.
- Form filters only accept `4` and `8-K`.
- Paid subscriptions must include a webhook URL even if you primarily use the
  pull API.
