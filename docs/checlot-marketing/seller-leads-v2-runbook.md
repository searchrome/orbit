# Checklot Marketing — Seller Leads V2 Runbook

## Purpose

This document explains how to use:

- `scripts/collect-sellers-v2.js`
- `scripts/merge-seller-leads-v2.js`

for collecting and merging Marktplaats seller lead results for `checklot.nl`.

## Current Script

Primary collector:

- `scripts/collect-sellers-v2.js`

What it does:

- opens Marktplaats category pages through the local CDP browser
- discovers listing URLs
- visits listing detail pages
- extracts seller-facing signals such as:
  - `sellerName`
  - `profileUrl`
  - `city`
  - `postalCodes`
  - `memberSince`
  - `rating`
  - `reviewCount`
  - `phoneNumbers`
  - `emails`
  - `websites`
  - `websiteButtonVisible`
  - `phoneButtonVisible`
  - `isBusinessLikely`

Outputs:

- JSON files under `scripts/logs/`
- optional CSV from merged historical results using `scripts/merge-seller-leads-v2.js`

## Requirements

Before running the collector:

1. Start the Electron browser with CDP enabled on port `9222`.
2. Keep the browser open while the collector is running.

The collector is a one-shot CLI:

- it runs
- writes files
- exits automatically when done

## Main Command

Example:

```bash
node scripts/collect-sellers-v2.js \
  --categories computers-en-software \
  --pages 100 \
  --visit-limit 350 \
  --resume-state scripts/logs/seller_leads_v2_state.json \
  --format json
```

## Important Flags

- `--categories <csv>`
  - category key or comma-separated keys
- `--pages <n>`
  - how many category/search pages to scan
- `--visit-limit <n>`
  - max number of discovered listing pages to open and inspect
- `--resume-state <file>`
  - stores seen listing URLs and seller keys so repeated runs skip previously processed items
- `--format json|csv|both`
  - output file format for that run

## How The Limits Work

- `--pages` controls discovery breadth
- `--visit-limit` controls how many discovered listings are actually opened

Actual visited listings are:

- `min(newly discovered listings, visit-limit)`

If the state file already contains many seen listings, a large `visit-limit` will still produce a smaller real visit count.

## Current Categories We Have Run

These categories have already been used:

- `audio-tv-en-foto`
- `computers-en-software`
- `electronics`

Important note:

- `electronics` is only an alias for `audio-tv-en-foto`
- both point to the same Marktplaats category
- do not run both if the goal is new category coverage

Current mapped paths:

- `audio-tv-en-foto` → `/cp/31/audio-tv-en-foto/`
- `electronics` → `/cp/31/audio-tv-en-foto/`
- `computers-en-software` → `/cp/322/computers-en-software/`

## Recommended Next Categories

If the goal is broader Checklot lead coverage, run these next:

- `antiek-en-kunst`
- `kunst`
- `antiek`
- `verzamelen`
- `munten-en-biljetten`
- `postzegels`
- `sieraden`
- `meubels`

Why these next:

- they are already supported by the category map
- they are closer to vintage, collectibles, art, jewelry, and second-hand inventory
- they are likely more relevant to Checklot than continuing to over-focus on electronics

## Suggested Run Order

Recommended order:

1. `computers-en-software`
2. `antiek-en-kunst`
3. `kunst`
4. `antiek`
5. `verzamelen`
6. `munten-en-biljetten`
7. `postzegels`
8. `sieraden`
9. `meubels`

Do not add `electronics` after `audio-tv-en-foto`, because that is duplicate coverage.

## Example Category Runs

Computers/software:

```bash
node scripts/collect-sellers-v2.js \
  --categories computers-en-software \
  --pages 100 \
  --visit-limit 350 \
  --resume-state scripts/logs/seller_leads_v2_state.json \
  --format json
```

Art / antiques:

```bash
node scripts/collect-sellers-v2.js \
  --categories antiek-en-kunst,kunst,antiek \
  --pages 100 \
  --visit-limit 350 \
  --resume-state scripts/logs/seller_leads_v2_state.json \
  --format json
```

Collectibles / jewelry:

```bash
node scripts/collect-sellers-v2.js \
  --categories verzamelen,munten-en-biljetten,postzegels,sieraden \
  --pages 100 \
  --visit-limit 350 \
  --resume-state scripts/logs/seller_leads_v2_state.json \
  --format json
```

## Results Location

Per-run outputs are written to:

- `scripts/logs/seller_leads_v2_<timestamp>.json`

Resume state file:

- `scripts/logs/seller_leads_v2_state.json`

Typical run summary fields:

- `uniqueListings`
- `visitedListings`
- `uniqueLeads`
- `leadsWithPhone`
- `leadsWithEmail`
- `leadsWithWebsite`
- `leadsWithContactButton`
- `businessLikely`
- `skippedSeenListings`
- `skippedSeenLeads`

## Merge Historical Results

Merge all collected `seller_leads_v2_*.json` run files into one CSV:

```bash
node scripts/merge-seller-leads-v2.js
```

What the merge script does:

- reads `scripts/logs/seller_leads_v2_*.json`
- ignores state files
- merges duplicate records primarily by `listingUrl`
- unions contact arrays such as:
  - `phoneNumbers`
  - `emails`
  - `websites`
- writes one merged CSV back into `scripts/logs/`

Custom output path:

```bash
node scripts/merge-seller-leads-v2.js \
  --output scripts/logs/checklot-merged-leads.csv
```

## Notes

- The collector writes output only at the end of a run.
- A very large run can take a long time because each listing page is opened individually.
- If output counts look too small, check:
  - whether the category is already saturated in `seller_leads_v2_state.json`
  - whether the category key is mapped
  - whether `audio-tv-en-foto` and `electronics` were unintentionally treated as separate categories
