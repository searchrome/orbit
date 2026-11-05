# Seller Collectors — Status & Handoff

## Purpose

Collect Marktplaats seller leads for `checklot.nl` by browsing real Marktplaats category pages through the existing CDP browser session.

Target sellers:
- antiques
- art
- collectibles
- jewelry

The collector flow is intentionally **not LLM-driven**. It uses direct browser scraping for throughput, then uses the listing pages themselves to extract seller identity and contact signals.

There are now two collector variants:

- `scripts/collect-sellers.js`
  - baseline seller collector
  - focuses on seller identity and optional profile enrichment
- `scripts/collect-sellers-v2.js`
  - lead-oriented collector
  - focuses on direct contact evidence, seller-side action buttons, and measurable yield stats

## Current Design

### Phase 1 — Category listing discovery

The collector:
- opens its **own dedicated browser tab**
- navigates Marktplaats category pages
- scrolls a few times to let listing cards hydrate
- extracts listing URLs, titles, prices, and rough location text from `a[href*="/v/"]` listing links
- dedupes listings by canonical listing URL

This avoids the previous collision with the workspace agent’s active tabs.

### Phase 2 — Listing-page seller extraction

The collector now visits each listing page directly and extracts seller information inline from the listing page:
- seller display name
- location
- member-since text
- rating / review count
- business signals
- phone / website when visible
- sample listing metadata

This is now the **primary** seller extraction path.

### Phase 3 — Optional seller profile enrichment

If a real seller profile URL exists (`/u/`), and `--skip-profiles` is **not** set, the collector optionally visits that seller profile for extra enrichment:
- listing count
- member since
- rating / reviews
- location
- phone / website

## What Was Fixed

### 1. Wrong CDP target

Previously the script reused an arbitrary existing tab. That was unsafe and could collide with the browser UI or AI workspace.

Now the script opens its **own assistant-owned tab** through `CdpBrowserSession.openTab({ url: 'about:blank', activate: true })`.

### 2. Category-page selector strategy

Previously the script expected seller profile links and brittle DOM selectors on category pages.

Now it:
- hydrates the page with a few scrolls
- extracts real listing links from `a[href*="/v/"]`
- canonicalizes URLs
- reads listing metadata from the nearest visible card root

### 3. Seller extraction path

Previously the script assumed seller profile pages were the main source of truth.

Now the main source of truth is the **listing page itself**, because Marktplaats often exposes seller identity inline and may only link to `#verkoper` instead of a clean `/u/` profile URL.

## Important Remaining Risks

### 1. Inline seller parsing is heuristic

The listing-page seller parser uses text patterns such as:
- `X jaar op Marktplaats`
- `4.0 · 1 review`
- short location lines

This is much better than the previous approach, but it is still heuristic. If Marktplaats changes the seller card wording, the parser may need tuning.

### 2. Listing count is often unavailable

When Marktplaats does not expose a real seller profile URL, we cannot reliably fetch seller-wide listing counts. In those cases the collector still returns a usable seller lead, but `listingCount` may stay `0`.

### 3. Category hydration may still vary

The script scrolls the page to trigger hydrated listing cards. If Marktplaats changes lazy-loading or consent behavior, the collector may need:
- an extra wait
- a consent-dismiss step
- or a slightly different scroll cadence

## V2 Collector Notes

`collect-sellers-v2.js` currently runs best against:

- `electronics` → `https://www.marktplaats.nl/cp/31/audio-tv-en-foto/`

Its output separates:

- **direct contact points**
  - actual `phoneNumbers`, `emails`, `websites`
- **contact actions**
  - seller sidebar buttons such as `Website` or `Toon nummer`

This distinction matters because a visible button is **not** the same as an extracted contact detail.

### Latest live v2 electronics smoke run

Command:

```bash
node scripts/collect-sellers-v2.js --categories electronics --pages 1 --visit-limit 12 --format json
```

Latest output:

- `scripts/logs/seller_leads_v2_2026-06-03T17-09-15.json`

Observed stats:

- `12` listing visits
- `8` unique seller leads
- `66.7%` seller-yield rate
- `75%` direct contact-point rate
- `87.5%` contact-action rate
- `6` leads with phone numbers
- `5` leads with emails
- `4` direct websites
- `7` leads with visible contact buttons

Interpretation:

- seller-level dedupe is now working
- trusted contact-button handling materially improved direct contact recovery
- the remaining gap is breadth, not basic extraction

## Current CLI

```bash
node scripts/collect-sellers.js \
  --categories antiek-en-kunst,sieraden,verzamelen \
  --pages 3 \
  --profile-limit 50 \
  --format both
```

Important flags:
- `--categories <csv>`
- `--pages <n>`
- `--profile-limit <n>` — currently also limits how many listing pages are visited for seller extraction
- `--skip-profiles` — skip optional `/u/` seller profile enrichment

V2:

```bash
node scripts/collect-sellers-v2.js \
  --categories electronics \
  --pages 3 \
  --visit-limit 80 \
  --format both
```

## Related LLM Browser Script

For the separate **LLM + browser** agent flow, use:
- `scripts/cdp-agent-cli.js`

It now supports:
- `--backend codex|claude`
- `--model <model>`
- `--reasoning-effort <low|medium|high|xhigh>` for Codex

Example:

```bash
node scripts/cdp-agent-cli.js \
  --backend codex \
  --model gpt-5.4-mini \
  --reasoning-effort xhigh \
  "find promising antiques sellers on Marktplaats"
```

## Recommended Next Checks

1. Keep `electronics` as the baseline category until v2 yield stabilizes.
2. Improve direct contact recovery before scaling page depth:
   - inspect `Toon nummer`
   - inspect `Website`
   - capture reveal/redirect targets if possible
3. Add a confidence field per contact point in `collect-sellers-v2.js`.
4. Only after contact recovery improves, scale to multi-page runs for hundreds of leads.
