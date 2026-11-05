# Agent Runbook — Muhasebe Uzmanı Candidate Sourcing (LinkedIn)

This document explains how the Muhasebe Uzmanı (Accounting Specialist) candidate
sourcing was performed for Istanbul, so a future agent can reproduce, continue, or
improve the process.

## Goal

Find good candidates living in Istanbul for a **Muhasebe Uzmanı** role:

- General accounting experience, ideally **3+ years**
- Preferably **open to work** (O2W)
- Knowledge of cari hesap (open items), banka-kasa, fatura, mutabakat
  (reconciliation), dönem sonu (period end) and financial reporting
- TDHP (Tek Düzen Hesap Planı), tax legislation, e-Fatura, e-Arşiv, e-Defter
- At least one ERP/accounting package: Logo, Mikro, Netsis, Luca, Nebim (SAP also valued)
- Degree in İşletme / İktisat / Maliye / Muhasebe
- Output goes into `linkedin/deepseek_last.csv`, avoiding candidates already scanned.

## Output file

`linkedin/deepseek_last.csv` — columns (10, header):

```
Durum,Ad Soyad,Unvan,Sirket,Lokasyon,O2W,Deneyim,SMMM/SM,Elenme Notu,LinkedIn URL
```

- `Durum`: `UYGUN` (fit) / `DOĞRULANMALI` (needs O2W/experience confirmation) /
  `ELENDİ` (rejected) / `YENİ` (placeholder, not yet reviewed) / `YEDEK`.
- `O2W`: `EVET` / `Görünmüyor` / `Bilinmiyor`.
- Row values that contain commas (e.g. reason text) must be quoted.

## Environment

- Electron browser (this project) is the browsing surface.
- It must be running with CDP on port 9222:
  ```bash
  scripts/electron-launcher.sh start --port 9222
  scripts/electron-launcher.sh status   # expect "CDP: ready"
  ```
- A **logged-in LinkedIn session** inside the browser is required. If the session
  expires, LinkedIn shows an authwall (`https://www.linkedin.com/authwall?...`) and
  profile reads fail — re-login manually in the visible window, then resume.
- CDP driver library: `scripts/cdp-browser-session.js` (`CdpBrowserSession`).

## Pipeline at a glance

```
1. Scan LinkedIn people search (İstanbul)  -> candidate list JSON
2. Diff against existing CSV                -> "fresh" candidates only
3. Visit each fresh candidate's profile     -> verified facts (location, O2W, exp, kws)
4. Personally review each verified profile  -> status + DataFrame note
5. Append / update CSV rows
```

---

## Step 1 — Search scan (`scripts/linkedin-scan.js`)

Collects candidate cards from LinkedIn people search for `muhasebe uzmanı` in İstanbul.

Key points:
- The correct İstanbul geo filter is **two geo URNs**: `119068902` (İstanbul) and
  `102424322` (Kadıköy). The URL must contain:
  ```
  geoUrn=%5B%22119068902%22%2C%22102424322%22%5D
  ```
  i.e. URL-encoded `["119068902","102424322"]`.
- A plain `geoUrn=["103155411"]` did **not** resolve to İstanbul in this account
  (linked to a UK region); selecting the location through the UI is unreliable via
  scripts, so use the literal geo URNs above.
- URL pattern:
  ```
  https://www.linkedin.com/search/results/people/?keywords=<kw>&origin=FACETED_SEARCH&geoUrn=<geo>&page=<N>
  ```
- Task cards in the current LinkedIn UI are `div[role="listitem"]` (not `<li>`).
  The card extractor reads, per card: name (from `a[href*="/in/"]` innerText),
  profile URL, headline, location, O2W flag, snippet.
- The O2W badge often appears only as the photo ring (`aria-label "… is open to work"`)
  and is **not** in `innerText` — so the search-card O2W flag should be carried into
  the profile result as a secondary signal (`o2wSearch`).

Run (13 pages ~ 2 min):
```bash
PAGES=13 node scripts/linkedin-scan.js > .tmp/scan_out.log 2>&1
```

Artifacts written (under `.tmp/`):
- `linkedin_fresh.json` — candidates **not** already in the CSV
  (dedupe by normalized profile URL, stripping `/en/` suffixes).
- `linkedin_candidates.json` — all unique candidates found.

Reading CSV for dedupe:
- Skip heading; existing URLs are normalized with
  `new URL(url).href.replace(/\/$/,'').toLowerCase()`.
- Around 108–113 previously-scanned profiles were present; the scan found ~130 unique
  cards and ~87 fresh (unscanned) candidates across 13 pages.

## Step 2 — Profile verification (`scripts/linkedin-profiles.js`)

Visits **each fresh candidate's real profile page** in the browser and reads the
rendered page content.

Behavior:
- Resumes from `.tmp/linkedin_profiles.json` (skips URLs already checked).
- Uses a **30 s delay between profiles** (`DELAY_MS=30000`, plus ~10 s load wait)
  to avoid triggering LinkedIn's bot detection.
- Prints a **verdict per candidate immediately after collection** (`analyze()`:
  ELENDİ non-İstanbul / UYGUN if O2W+exp/ERP / else DOĞRULANMALI), so review is
  incremental rather than batch-at-the-end.
- For each candidate: `browser.navigate(tabId, url)`, wait, then fetch
  `JSON.stringify({ body: document.body.innerText, main: main.innerText })`.
- `parseProfile()` (in Node, not the browser) splits `main` text into lines and
  extracts:
  - name (line 0), degree tag (`· 2nd`), headline, location, company, university,
    connections count
  - O2W badge from full `body` text
  - About section (between "About" and "Activity")
  - experience hints (year ranges / "N yıl" patterns)
  - keyword hits (logo, mikro, netsis, luca, nebim, sap, e-fatura, e-arsiv,
    e-defter, excel, tek düzen, genel muhasebe, cari hesap, mutabakat, vergi,
    finansal raporlama, smm, bordro, ...)
- Records `o2wSort = profileO2W || searchCardO2W`.

Run:
```bash
node scripts/linkedin-profiles.js > .tmp/profiles_out.log 2>&1
```

Result: `.tmp/linkedin_profiles.json` (69 records in the latest run: 38 fully
verified, 31 authwalled).

## Step 3 — Human-quality review (no script)

The extracted facts (location, O2W, company, About, keywords) are **not** a decision.
A reviewer reads each candidate's profile data and assigns a status:

- **UYGUN** — accounting role, 3+ yrs experience (or clearly senior), O2W visible,
  ERP/e-Fatura/TDHP signals. Examples added:
  - Fadime KAHRAMAN (O2W, 12+ yıl, "Aktif iş Arayan")
  - Gülnur Toksöz (Logo Go3/Tiger, SAP, e-Fatura/e-Arşiv, senior)
  - Onur Uçar (O2W, Muhasebe Şefi)
  - Yavuz S. / Esra Kavas / ELMAS DURSUN (upgraded, URLs added)
- **DOĞRULANMALI** — good accounting profile but O2W not confirmed and/or years
  unclear (majority of new rows).
- **ELENDİ** — rejected: SMMM/Mali Müşavir title holders (per prior convention),
  HR/İK roles, tourism, muhasebe-yardımcısı, stajyer, empty profiles.

## Step 4 — CSV update (`scripts/update-csv.js`)

- `updates` map: matches existing rows by name and rewrites them
  (used to upgrade Yavuz S., Esra Kavas, ELMAS DURSUN, Muhammet KAMİLÇELEBİ and add
  their profile URLs).
- `fresh` + `elendi` arrays: new rows appended in the same 10-column shape.
- Dedupes by profile URL before appending (so re-running is safe).
- After update, verify: 147 rows, no duplicate URLs, no 11-field rows.

## Step 5 — CSV normalization (`scripts/normalize-csv.js`)

Required because the original file had **56 pre-existing `YENİ` placeholder rows**
with 11 columns (an extra comma), which shifted every column after the name and made
numeric columns unreadable in parsers/Excel. This script:

- Parses every line with a proper CSV tokenizer (handles quoted commas).
- Rebuilds `YENİ` rows to the correct 10-column layout
  (`YENİ,name,,,,,,,,<note>,<url>`).
- Pads/truncates any other row to exactly 10 columns.
- Writes the normalized file back and reports how many rows were fixed.

Verify after normalization: every non-header row parses to exactly 10 fields.

---

## Gotchas learned

1. **Location filter**: use the literal two geo URNs (`119068902` + `102424322`).
   Do not rely on the UI dropdown or single Food-based URNs.
2. **LinkedIn logs out** after heavy automation; detect authwall URL and stop/relog.
   The profile checker marks such records `{ error: "authwall" }` and can be resumed.
3. **Card DOM**: current LinkedIn search uses `div[role="listitem"]`; old selectors
   (`li.entity-result`) fail silently.
4. **O2W detection**: photo ring badge is not in `innerText`; combine search-card
   flag + profile body text.
5. **Escape pitfalls**: when building the in-browser evaluate string via a JS
   template literal, `\n` / `\s` must be double-escaped (`\\n`, `\\s`) or the browser
   receives broken syntax. Doing parsing in Node (fetch `innerText` as raw JSON) is
   more robust.
6. **CSV quoting**: values with commas (reasons, multi-company) must be quoted;
   parse+normalize any existing file before trusting column alignment.
7. **`page=N` param**: pages past ~10 exist; scan ran 13 pages and still found fresh
   candidates, so increase `PAGES` for broader coverage.

## Current state (last run)

- CSV: 196 rows — UYGUN 23, DOĞRULANMALI 78, ELENDİ 38, YEDEK 1, YENİ 56.
- **Round 2 (resumed)**: 49 remaining candidates were verified at a **30 s interval**
  (`DELAY_MS=30000`), one profile at a time, with a per-candidate verdict printed
  immediately after collection (`analyze()` in `linkedin-profiles.js`).
  Verdict rules: ELENDİ if non-İstanbul; UYGUN if O2W ✓ with ≥3 yıl/senior/ERP,
  or strong ERP+e-Fatura+genel muhasebe signals; else DOĞRULANMALI.
  Result: +6 UYGUN (Caner GÜVEN, Nurgül Hedef, YÜCEL ADIGÜZEL, Mustafa Arslan,
  Havva Doğan, Burak Saka), +31 DOĞRULANMALI, +12 ELENDİ (SMMM/Mali Müşavir titles).
- Added via `scripts/update-csv2.js`; file normalized to 10 columns, 0 dup URLs.

## Resume checklist

1. Start browser with CDP: `scripts/electron-launcher.sh start --port 9222`.
2. Confirm LinkedIn is logged in (open a public profile; no authwall).
3. `node scripts/linkedin-profiles.js` (resumes unverified fresh candidates).
4. Review new records in `.tmp/linkedin_profiles.json`.
5. Extend `scripts/update-csv.js` and run it.
6. Run `scripts/normalize-csv.js`; verify 10 columns per row and zero dup URLs.