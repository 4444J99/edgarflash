# EdgarFlash

> Real-time SEC EDGAR alerts (Form 4, 8-K). Cron-driven Cloudflare Worker.

**Live:** https://edgarflash.ivixivi.workers.dev

EdgarFlash polls SEC EDGAR Form 4 (insider transactions) and 8-K (material events) Atom
feeds every minute, dedupes against the last-seen state in KV, and delivers fresh
filings via webhook to paid subscribers. Free tier shows the last 50 filings on the web
feed.

## API

```
GET  /api/recent            — Last 50 filings (web feed)
GET  /api/by-cik/:cik       — Filings for a specific CIK
POST /api/subscribe         — Subscribe webhook to filing types
GET  /api/status            — System health
```

## Pricing

| Tier      | Price     | What's included                                      |
|-----------|-----------|------------------------------------------------------|
| Free      | $0        | Last 50 filings, web feed, public API                |
| Pro       | $99/mo    | Real-time webhook (Form 4 + 8-K) within 60s of EDGAR |
| Hedge     | $999/mo   | Custom CIK watchlist + Slack/Teams + SLA + history   |

**Pay any rail:** GitHub Sponsors, crypto, BMC, latent Stripe.

## Use cases

- Insider transaction signal layer for trading systems
- 8-K material event alerts for analysts and journalists
- Portfolio-company watch (custom CIK list at Hedge tier)

## Stack

- Cloudflare Workers (compute + 1-min cron)
- Cloudflare KV — last-seen state, subscription registry
- SEC EDGAR Atom feeds (no API key required)

## Sister products

EdgarFlash is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
