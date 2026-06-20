# EdgarFlash

> Real-time SEC EDGAR alerts (Form 4, 8-K). Cron-driven Cloudflare Worker.

**Live:** https://edgarflash.ivixivi.workers.dev

EdgarFlash polls SEC EDGAR Form 4 (insider transactions) and 8-K (material events) Atom
feeds every minute, dedupes against the last-seen state in KV, and delivers fresh
filings via webhook and API-key feeds to paid subscribers. Free tier is delayed
15 minutes and limited to 10 filings.

## API

```
GET  /api/feed              — Delayed public feed; real-time with Authorization: Bearer ef_live_...
GET  /api/realtime          — Paid API-key real-time feed
POST /api/subscribe         — Create free/pending paid subscription
POST /api/confirm           — Confirm payment and receive one-time API key
GET  /api/subscription/:id  — Subscription status, no API secret
GET  /api/status            — System health
```

Paid API calls accept either `Authorization: Bearer <api_key>` or `x-api-key:
<api_key>`.

## Authentication

Paid subscriptions receive a single API key from `POST /api/confirm` after
payment confirmation. The key is only returned on activation; EdgarFlash stores
the key id plus a hash in `EF_SUBS`, never the secret itself.

Use the key on real-time requests:

```bash
curl -H "Authorization: Bearer $EDGARFLASH_API_KEY" \
  https://edgarflash.ivixivi.workers.dev/api/realtime
```

When `EF_API_KEY_SECRET` is configured, new API keys are stored as
HMAC-SHA256 hashes using that secret. Without it, new keys use the legacy
SHA-256 hash format. Legacy SHA-256 hashes remain accepted so existing paid
subscribers keep working during rollout.

## Configuration

`wrangler.toml` defines the Worker entrypoint, static assets, cron schedule,
`EF_STATE` / `EF_SUBS` KV bindings, the public `USER_AGENT`, the optional
`PAYRAIL_URL`, and the preferred `PAYRAIL` service binding.

Secrets are configured outside `wrangler.toml`:

```bash
wrangler secret put EF_API_KEY_SECRET   # HMAC secret for API-key hashes
wrangler secret put SHIP_HMAC_SECRET    # optional signature for payrail receipts
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
development-only values. `.dev.vars` is gitignored.

## Pricing

| Tier          | Price   | What's included                                      |
|---------------|---------|------------------------------------------------------|
| Free          | $0      | 15-minute delayed feed, latest 10 filings            |
| Pro           | $99/mo  | Real-time API key + webhook, 25 ticker filters       |
| Institutional | $299/mo | Real-time API key + webhook, 100 ticker filters      |

Paid access is issued for a 31-day period after payment confirmation.

## Use cases

- Insider transaction signal layer for trading systems
- 8-K material event alerts for analysts and journalists
- Portfolio-company watch (custom CIK list at Institutional tier)

## Stack

- Cloudflare Workers (compute + 1-min cron)
- Cloudflare KV — last-seen state, subscription registry
- SEC EDGAR Atom feeds (no SEC API key required)
- Hashed EdgarFlash API keys stored in KV for paid real-time access

## Development

```bash
npm install
npm run lint        # eslint (flat config + typescript-eslint)
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests
npm run build       # wrangler deploy --dry-run (bundles the Worker)
npm run dev         # wrangler dev (local)
```

CI (`.github/workflows/ci.yml`) runs lint, type-check, tests, and the build on
every pull request and on pushes to `main`.

## Sister products

EdgarFlash is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
