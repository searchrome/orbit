#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CdpBrowserSession } = require('./cdp-browser-session.js');

const MARKTPLAATS_BASE = 'https://www.marktplaats.nl';

const CATEGORY_MAP = {
    'antiek-en-kunst': '/cp/1/antiek-en-kunst/',
    'sieraden': '/cp/1826/sieraden/',
    'verzamelen': '/cp/1680/verzamelen/',
    'electronics': '/cp/31/audio-tv-en-foto/',
    'audio-tv-en-foto': '/cp/31/audio-tv-en-foto/',
    'computers-en-software': '/cp/322/computers-en-software/',
    'kunst': '/l/antiek-en-kunst/kunst/c91/',
    'antiek': '/l/antiek-en-kunst/antiek/c2/',
    'munten-en-biljetten': '/l/verzamelen/munten-en-biljetten/c1692/',
    'postzegels': '/l/verzamelen/postzegels-en-poststukken/c1694/',
    'meubels': '/l/huis-en-inrichting/meubels-stoelen/c575/',
};

const DEFAULT_CATEGORIES = ['antiek-en-kunst', 'sieraden', 'verzamelen'];

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        categories: DEFAULT_CATEGORIES,
        pages: 10,
        output: path.join(__dirname, 'logs'),
        format: 'both',
        port: 9222,
        delay: 2000,
        profileLimit: 200,
        skipProfiles: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--categories':
                opts.categories = args[++i].split(',').map((value) => value.trim()).filter(Boolean);
                break;
            case '--pages':
                opts.pages = parseInt(args[++i], 10);
                break;
            case '--output':
                opts.output = args[++i];
                break;
            case '--format':
                opts.format = args[++i];
                break;
            case '--port':
                opts.port = parseInt(args[++i], 10);
                break;
            case '--delay':
                opts.delay = parseInt(args[++i], 10);
                break;
            case '--profile-limit':
                opts.profileLimit = parseInt(args[++i], 10);
                break;
            case '--skip-profiles':
                opts.skipProfiles = true;
                break;
        }
    }

    return opts;
}

function log(level, ...args) {
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m' };
    console.log(`${prefix[level] || ''}[${ts}][${level}]\x1b[0m`, ...args);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parsePriceValue(value) {
    const text = String(value || '').replace(/\u00a0/g, ' ');
    const match = text.match(/(?:€|eur)\s*([\d.]+(?:,\d{1,2})?)/i);
    if (!match) {
        return null;
    }
    const normalized = match[1].replace(/\./g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function canonicalizeListingUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw, MARKTPLAATS_BASE);
        [
            'c',
            'casData',
            'trackSearch',
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'gclid',
            'fbclid'
        ].forEach((key) => parsed.searchParams.delete(key));
        const search = parsed.searchParams.toString();
        parsed.search = search ? `?${search}` : '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return raw.split('#')[0];
    }
}

function buildSellerKey(record) {
    const profileUrl = normalizeWhitespace(record?.profileUrl);
    if (profileUrl && !profileUrl.endsWith('#verkoper')) {
        return profileUrl.toLowerCase();
    }

    const sellerName = normalizeWhitespace(record?.name).toLowerCase();
    const location = normalizeWhitespace(record?.location).toLowerCase();
    if (!sellerName) {
        return '';
    }

    return `${sellerName}|${location}`;
}

function mergeSampleListings(existing = [], nextListing) {
    if (!nextListing?.url && !nextListing?.title) {
        return existing.slice(0, 3);
    }

    const merged = [];
    const seen = new Set();
    for (const entry of [...existing, nextListing]) {
        const key = normalizeWhitespace(entry?.url) || normalizeWhitespace(entry?.title).toLowerCase();
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        merged.push({
            title: normalizeWhitespace(entry?.title),
            url: normalizeWhitespace(entry?.url),
            price: normalizeWhitespace(entry?.price),
        });
        if (merged.length >= 3) {
            break;
        }
    }

    return merged;
}

function mergeSellerRecord(existing, incoming) {
    const merged = existing ? { ...existing } : {
        name: '',
        profileUrl: '',
        location: '',
        listingCount: 0,
        memberSince: '',
        rating: '',
        reviews: 0,
        isBusiness: false,
        phone: '',
        website: '',
        category: incoming.category || '',
        foundOnPage: incoming.foundOnPage || 0,
        sampleListings: []
    };

    for (const field of ['name', 'profileUrl', 'location', 'memberSince', 'rating', 'phone', 'website', 'category']) {
        if (!merged[field] && incoming[field]) {
            merged[field] = incoming[field];
        }
    }

    if (!merged.foundOnPage && incoming.foundOnPage) {
        merged.foundOnPage = incoming.foundOnPage;
    }

    merged.isBusiness = Boolean(merged.isBusiness || incoming.isBusiness);
    merged.listingCount = Math.max(Number(merged.listingCount) || 0, Number(incoming.listingCount) || 0);
    merged.reviews = Math.max(Number(merged.reviews) || 0, Number(incoming.reviews) || 0);
    merged.sampleListings = mergeSampleListings(merged.sampleListings, incoming.sampleListing);

    return merged;
}

function parseInlineSellerSnapshot(snapshot = {}) {
    const lines = Array.isArray(snapshot.lines)
        ? snapshot.lines.map((line) => normalizeWhitespace(line)).filter(Boolean)
        : [];

    let name = normalizeWhitespace(snapshot.sellerName);
    const memberSince = normalizeWhitespace(snapshot.memberSince);
    let location = normalizeWhitespace(snapshot.location);
    const locationNoisePattern = /^(?:help en info|voorwaarden|veiligheidscentrum|berichten|meldingen|inloggen|plaats advertentie|ga naar advertenties|zoek|home|alle categorieën|alle afstanden|bewaar je zoekopdracht)$/i;

    if (!name && memberSince) {
        const index = lines.findIndex((line) => line === memberSince);
        if (index > 0) {
            for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor--) {
                const candidate = lines[cursor];
                if (!candidate) {
                    continue;
                }
                if (/^(?:€|eur|bieden|zie omschrijving|vandaag|gisteren|sinds )/i.test(candidate)) {
                    continue;
                }
                if (/review|op marktplaats|bericht|bel|mail/i.test(candidate)) {
                    continue;
                }
                name = candidate;
                break;
            }
        }
    }

    if (!name && snapshot.profileUrl && /#verkoper$/i.test(snapshot.profileUrl)) {
        const sellerAnchorLine = lines.find((line) => !/review|op marktplaats|bericht/i.test(line));
        if (sellerAnchorLine) {
            name = sellerAnchorLine;
        }
    }

    if (!location) {
        const sinceIndex = lines.findIndex((line) => /^Sinds\b/i.test(line));
        if (sinceIndex > 0) {
            const candidate = lines[sinceIndex - 1];
            if (candidate && !locationNoisePattern.test(candidate) && /^(?:[A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})$/.test(candidate)) {
                location = candidate;
            }
        }
    }

    if (!location) {
        const candidate = lines.find((line, index) => {
            if (!/^(?:[A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})$/.test(line)) {
                return false;
            }
            if (locationNoisePattern.test(line)) {
                return false;
            }
            const next = lines[index + 1] || '';
            return /^Sinds\b/i.test(next) || /\bjaar op Marktplaats\b/i.test(next);
        });
        if (candidate) {
            location = candidate;
        }
    }

    if (locationNoisePattern.test(location)) {
        location = '';
    }

    if (location && name && location.toLowerCase() === name.toLowerCase()) {
        location = '';
    }

    return {
        name,
        profileUrl: normalizeWhitespace(snapshot.profileUrl),
        location,
        memberSince,
        rating: normalizeWhitespace(snapshot.rating),
        reviews: Number(snapshot.reviews) || 0,
        isBusiness: Boolean(snapshot.isBusiness),
        phone: normalizeWhitespace(snapshot.phone),
        website: normalizeWhitespace(snapshot.website),
    };
}

async function hydrateMarktplaatsResults(browser, tabId, delayMs) {
    await browser.waitForLoad(tabId, 20000);
    let lastCount = 0;

    for (let attempt = 0; attempt < 4; attempt++) {
        const links = await browser.querySelectorAll({ tabId, selector: 'a[href*="/v/"]', fields: ['href'] });
        lastCount = Array.isArray(links.items) ? links.items.length : 0;
        if (lastCount >= 10) {
            break;
        }

        await browser.scrollPage({ tabId, amount: 1400 });
        await sleep(Math.max(250, Math.min(delayMs, 1500)));
    }

    return lastCount;
}

async function extractListingSummariesFromCategoryPage(browser, tabId) {
    const items = await browser.evaluate(tabId, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const absoluteUrl = (value) => {
            const raw = String(value || '').trim();
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
                return null;
            }
            try {
                return new URL(raw, document.baseURI).href;
            } catch {
                return raw || null;
            }
        };
        const canonicalize = (value) => {
            const href = absoluteUrl(value);
            if (!href) {
                return null;
            }
            try {
                const parsed = new URL(href, document.baseURI);
                ['c', 'casData', 'trackSearch', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((key) => {
                    parsed.searchParams.delete(key);
                });
                const search = parsed.searchParams.toString();
                parsed.search = search ? ('?' + search) : '';
                parsed.hash = '';
                return parsed.toString();
            } catch {
                return href.split('#')[0];
            }
        };
        const pickLine = (lines, pattern) => lines.find((line) => pattern.test(line)) || '';
        const seen = new Set();
        const results = [];
        const anchors = Array.from(document.querySelectorAll('a[href*="/v/"]'));

        for (const link of anchors) {
            const href = canonicalize(link.href || link.getAttribute('href'));
            if (!href || seen.has(href)) {
                continue;
            }

            const root = link.closest('article')
                || link.closest('li')
                || link.closest('[class*="Listing"]')
                || link.closest('[class*="hz-Listing"]')
                || link.parentElement;
            const text = normalize(root?.innerText || link.innerText || link.textContent);
            if (!text) {
                continue;
            }

            const title = normalize(
                link.getAttribute('title')
                || root?.querySelector('h2, h3, [data-testid*="title" i]')?.textContent
                || link.innerText
                || link.textContent
            );
            if (!title || title.length < 4) {
                continue;
            }

            const lines = text.split(/\\n+/).map(normalize).filter(Boolean);
            const price = pickLine(lines, /(?:€|eur)\\s*[\\d.,]+|bieden|zie omschrijving/i);
            const location = pickLine(lines, /^(?:[A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})$/);
            const sellerName = pickLine(lines, /^(?:[A-ZÀ-Ý][A-Za-zÀ-ÿ0-9' .&-]{2,60})$/);

            seen.add(href);
            results.push({
                title,
                url: href,
                price,
                location,
                sellerName,
                snippet: text.slice(0, 400)
            });
        }

        return results.slice(0, 120);
    })()`, { timeoutMs: 25000 });

    return Array.isArray(items) ? items : [];
}

async function extractSubcategoryLinksFromHubPage(browser, tabId, categorySlug) {
    const items = await browser.evaluate(tabId, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const absoluteUrl = (value) => {
            const raw = String(value || '').trim();
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
                return null;
            }
            try {
                return new URL(raw, document.baseURI).href;
            } catch {
                return raw || null;
            }
        };
        const seen = new Set();
        const results = [];
        for (const link of Array.from(document.querySelectorAll('a[href]'))) {
            const href = absoluteUrl(link.href || link.getAttribute('href'));
            const text = normalize(link.innerText || link.textContent);
            if (!href || !text) continue;
            if (!href.includes('/l/')) continue;
            if (href.includes('/q/')) continue;
            if (href.includes('/diensten-en-vakmensen/')) continue;
            if (/home|help|privacy|voorwaarden|blog|marktplaats zakelijk/i.test(text)) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            results.push({ text, href });
        }
        return results.slice(0, 80);
    })()`, { timeoutMs: 15000 });

    const normalizedCategory = String(categorySlug || '').trim().toLowerCase();
    const filtered = (Array.isArray(items) ? items : []).filter((item) => {
        const href = String(item.href || '').toLowerCase();
        if (!href.startsWith(`${MARKTPLAATS_BASE.toLowerCase()}/l/`)) {
            return false;
        }
        if (!normalizedCategory) {
            return true;
        }
        const broadMatches = (
            (normalizedCategory === 'antiek-en-kunst' && href.includes('/antiek-en-kunst/')) ||
            (normalizedCategory === 'sieraden' && href.includes('/sieraden/')) ||
            (normalizedCategory === 'verzamelen' && href.includes('/verzamelen/'))
        );
        return broadMatches || href.includes(`/${normalizedCategory}/`);
    });

    return filtered;
}

async function getNextPageUrl(browser, tabId) {
    const url = await browser.evaluate(tabId, `(() => {
        const nextLink = document.querySelector(
            'a[rel="next"], ' +
            'a[data-testid="pagination-next"], ' +
            'a[class*="next" i], ' +
            'a[aria-label*="next" i], ' +
            'a[aria-label*="volgende" i], ' +
            'a[title*="Volgende" i]'
        );
        if (nextLink && nextLink.href) return nextLink.href;

        const pageLinks = document.querySelectorAll('a[href*="currentPage="], a[href*="page="]');
        const currentUrl = window.location.href;
        const currentPageMatch = currentUrl.match(/(?:currentPage|page)=(\\d+)/);
        const currentPage = currentPageMatch ? parseInt(currentPageMatch[1], 10) : 1;

        for (const link of pageLinks) {
            const pageMatch = link.href.match(/(?:currentPage|page)=(\\d+)/);
            if (pageMatch && parseInt(pageMatch[1], 10) === currentPage + 1) {
                return link.href;
            }
        }

        return null;
    })()`, { timeoutMs: 5000 });

    return url || null;
}

async function extractSellerFromListingPage(browser, tabId, listing) {
    await browser.navigate(tabId, listing.url);
    await sleep(1200);

    const snapshot = await browser.evaluate(tabId, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const text = document.body ? document.body.innerText : '';
        const lines = text.split(/\\n+/).map(normalize).filter(Boolean);
        const looksLikePrice = (value) => /(?:€|eur)\\s*[\\d.,]+|^bieden$|^zie omschrijving$/i.test(normalize(value));
        const pickText = (selector) => {
            const node = document.querySelector(selector);
            return node ? normalize(node.innerText || node.textContent) : '';
        };
        const firstMatchingLine = (predicate, maxLength = 80) => {
            for (const line of lines) {
                if (!line || line.length > maxLength) continue;
                if (predicate(line)) return line;
            }
            return '';
        };
        const externalLinks = Array.from(document.querySelectorAll('a[href]'))
            .map((node) => ({ href: node.href || node.getAttribute('href') || '', text: normalize(node.innerText || node.textContent) }))
            .filter((item) => item.href);

        const title = normalize(
            pickText('h1')
            || document.querySelector('meta[property="og:title"]')?.content
            || document.title.replace(/^≥\\s*/, '')
        );

        const locationMatch = text.match(/\\n([A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})\\nSinds\\s+[^\\n]+/);
        const memberSince = lines.find((line) => /(?:maand|jaar) op Marktplaats/i.test(line)) || '';
        const ratingLine = lines.find((line) => /\\d(?:[.,]\\d)?\\s*[·•]\\s*\\d+\\s*review/i.test(line) || /\\d+\\s*review/i.test(line)) || '';
        const ratingMatch = ratingLine.match(/(\\d(?:[.,]\\d)?)/);
        const reviewsMatch = ratingLine.match(/(\\d+)\\s*review/i);
        const phoneLink = externalLinks.find((item) => item.href.startsWith('tel:'));
        const websiteLink = externalLinks.find((item) => {
            if (!/^https?:/i.test(item.href)) return false;
            if (/marktplaats\\.nl|play\\.google\\.com|apps\\.apple\\.com|itunes\\.apple\\.com/i.test(item.href)) return false;
            if (/website|bezoek website|shop/i.test(item.text)) return true;
            return false;
        });
        const sellerAnchor = externalLinks.find((item) => /#verkoper$/i.test(item.href) || /\\/u\\//i.test(item.href));
        const priceSelectors = [
            '[data-testid*="price" i]',
            '[class*="price" i]',
            '[class*="Price" i]',
            'meta[property="product:price:amount"]'
        ];
        let priceLine = '';
        for (const selector of priceSelectors) {
            const value = selector.startsWith('meta[')
                ? document.querySelector(selector)?.getAttribute('content')
                : pickText(selector);
            if (value && looksLikePrice(value)) {
                priceLine = normalize(value);
                break;
            }
        }
        if (!priceLine) {
            priceLine = firstMatchingLine((line) => looksLikePrice(line), 60);
        }
        const isBusiness = /zakelijke verkoper|bedrijf|bezoek website|handelsinformatie/i.test(text)
            || Boolean(websiteLink)
            || /catawiki/i.test(sellerAnchor?.text || '');

        return {
            title,
            price: priceLine,
            location: locationMatch ? normalize(locationMatch[1]) : '',
            memberSince,
            rating: ratingMatch ? ratingMatch[1] : '',
            reviews: reviewsMatch ? parseInt(reviewsMatch[1], 10) : 0,
            phone: phoneLink ? normalize(phoneLink.href.replace(/^tel:/i, '')) : '',
            website: websiteLink ? websiteLink.href : '',
            isBusiness,
            profileUrl: sellerAnchor ? sellerAnchor.href : '',
            sellerName: sellerAnchor ? sellerAnchor.text : '',
            lines: lines.slice(0, 120)
        };
    })()`, { timeoutMs: 15000 });

    const inlineSeller = parseInlineSellerSnapshot(snapshot);

    return {
        name: inlineSeller.name || normalizeWhitespace(listing.sellerName),
        profileUrl: inlineSeller.profileUrl,
        location: inlineSeller.location || normalizeWhitespace(listing.location),
        listingCount: 0,
        memberSince: inlineSeller.memberSince,
        rating: inlineSeller.rating,
        reviews: inlineSeller.reviews,
        isBusiness: inlineSeller.isBusiness,
        phone: inlineSeller.phone,
        website: inlineSeller.website,
        sampleListing: {
            title: normalizeWhitespace(snapshot?.title || listing.title),
            url: canonicalizeListingUrl(listing.url),
            price: normalizeWhitespace(snapshot?.price || listing.price)
        }
    };
}

async function getSellerProfile(browser, tabId, profileUrl) {
    try {
        await browser.navigate(tabId, profileUrl);
        await sleep(1200);

        const profile = await browser.evaluate(tabId, `(() => {
            const text = document.body ? document.body.innerText : '';
            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
            const listingMatch = text.match(/(\\d+)\\s*(?:actieve\\s*)?advertentie/i);
            const sinceMatch = text.match(/(?:lid sinds|actief sinds|op Marktplaats sinds)\\s*([\\w\\s]+\\d{4})/i)
                || text.match(/(\\d+)\\s*jaar\\s*(?:op|actief)/i);
            const ratingMatch = text.match(/(\\d[.,]\\d)\\s*\\/\\s*5/);
            const reviewMatch = text.match(/(\\d+)\\s*(?:beoordelingen|reviews)/i);
            const locMatch = text.match(/(?:Locatie|Woonplaats|Plaats)[:\\s]+([^\\n]+)/i);
            const isBusiness = /zakelijke verkoper|bedrijf|kvk|btw/i.test(text);
            const phoneLink = Array.from(document.querySelectorAll('a[href^="tel:"]'))[0];
            const websiteLink = Array.from(document.querySelectorAll('a[href^="http"]')).find((node) => !/marktplaats\\.nl/i.test(node.href || ''));
            const nameEl = document.querySelector('h1, [class*="seller-name" i], [class*="username" i], [data-testid*="name" i]');

            return {
                displayName: normalize(nameEl ? nameEl.textContent : '').slice(0, 60),
                listingCount: listingMatch ? parseInt(listingMatch[1], 10) : 0,
                memberSince: sinceMatch ? normalize(sinceMatch[1]) : '',
                rating: ratingMatch ? ratingMatch[1] : '',
                reviews: reviewMatch ? parseInt(reviewMatch[1], 10) : 0,
                location: locMatch ? normalize(locMatch[1]) : '',
                isBusiness,
                phone: phoneLink ? normalize(phoneLink.href.replace(/^tel:/i, '')) : '',
                website: websiteLink ? websiteLink.href : '',
            };
        })()`, { timeoutMs: 10000 });

        return profile || {};
    } catch (error) {
        log('warn', `Failed to enrich seller profile ${profileUrl}: ${error.message}`);
        return {};
    }
}

async function collectSellers(opts) {
    const browser = new CdpBrowserSession({ baseUrl: `http://127.0.0.1:${opts.port}` });
    await browser.initialize();

    const { tab } = await browser.openTab({ url: 'about:blank', activate: true });
    const tabId = tab.id;

    const listingMap = new Map();
    const sellersMap = new Map();
    let totalPages = 0;
    let totalListingsSeen = 0;

    log('info', `Starting collection across ${opts.categories.length} categories, ${opts.pages} pages each`);
    log('info', `Dedicated collector tab: ${tabId}`);

    for (const category of opts.categories) {
        const categoryPath = CATEGORY_MAP[category];
        if (!categoryPath) {
            log('warn', `Unknown category "${category}", skipping. Available: ${Object.keys(CATEGORY_MAP).join(', ')}`);
            continue;
        }

        const queue = [`${MARKTPLAATS_BASE}${categoryPath}`];
        const queued = new Set(queue);
        const visited = new Set();
        let pageNum = 0;

        log('info', `\n── Category: ${category} ──`);

        while (queue.length && pageNum < opts.pages) {
            const pageUrl = queue.shift();
            if (!pageUrl || visited.has(pageUrl)) {
                continue;
            }
            visited.add(pageUrl);
            totalPages++;
            log('info', `  Candidate page ${totalPages}: ${pageUrl}`);

            const isHubPage = /\/cp\/\d+\//.test(pageUrl);

            try {
                await browser.navigate(tabId, pageUrl);
                await sleep(opts.delay);
                const hydratedCount = await hydrateMarktplaatsResults(browser, tabId, opts.delay);
                const listings = await extractListingSummariesFromCategoryPage(browser, tabId);

                // Hub pages (/cp/) don't support pagination — always discover subcategories
                if (listings.length === 0 || isHubPage) {
                    const subcategories = await extractSubcategoryLinksFromHubPage(browser, tabId, category);
                    if (subcategories.length > 0) {
                        log('info', `    Hub page exposed ${subcategories.length} subcategory links.`);
                        for (const subcategory of subcategories) {
                            if (!queued.has(subcategory.href) && !visited.has(subcategory.href)) {
                                queue.push(subcategory.href);
                                queued.add(subcategory.href);
                            }
                        }
                    }
                    if (listings.length === 0) {
                        continue;
                    }
                }

                pageNum++;
                log('info', `    Listing page ${pageNum}/${opts.pages}`);

                totalListingsSeen += listings.length;
                for (const listing of listings) {
                    const url = canonicalizeListingUrl(listing.url);
                    if (!url || listingMap.has(url)) {
                        continue;
                    }
                    listingMap.set(url, {
                        ...listing,
                        url,
                        category,
                        foundOnPage: pageNum
                    });
                }

                log('ok', `    Hydrated ${hydratedCount} listing links, extracted ${listings.length} listings, ${listingMap.size} unique total`);

                const nextUrl = await getNextPageUrl(browser, tabId);
                if (nextUrl && nextUrl !== pageUrl && !queued.has(nextUrl) && !visited.has(nextUrl)) {
                    queue.push(nextUrl);
                    queued.add(nextUrl);
                }

                // Fallback: construct /p/N/ URL for /l/ pages when no next link found
                if (!nextUrl && /\/l\/[^/]+\/[^/]+\/?$/.test(pageUrl.replace(/\?.*$/, ''))) {
                    const pageMatch = pageUrl.match(/\/p\/(\d+)\//);
                    const currentPageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;
                    const baseUrl = pageUrl.replace(/\/p\/\d+\//, '/').replace(/\?.*$/, '').replace(/\/+$/, '');
                    const constructedNext = `${baseUrl}/p/${currentPageNum + 1}/`;
                    if (!queued.has(constructedNext) && !visited.has(constructedNext)) {
                        queue.push(constructedNext);
                        queued.add(constructedNext);
                    }
                }
            } catch (error) {
                log('error', `    Page failed: ${error.message}`);
            }
        }
    }

    const listingsToVisit = Array.from(listingMap.values()).slice(0, Math.max(0, opts.profileLimit));
    log('info', `\n── Visiting ${listingsToVisit.length} listings for seller details ──`);

    for (let index = 0; index < listingsToVisit.length; index++) {
        const listing = listingsToVisit[index];
        if (index > 0 && index % 10 === 0) {
            log('info', `  Progress: ${index}/${listingsToVisit.length} listings`);
        }

        try {
            const seller = await extractSellerFromListingPage(browser, tabId, listing);
            const sellerKey = buildSellerKey(seller);

            if (!sellerKey) {
                continue;
            }

            const merged = mergeSellerRecord(sellersMap.get(sellerKey), {
                ...seller,
                category: listing.category,
                foundOnPage: listing.foundOnPage
            });

            sellersMap.set(sellerKey, merged);
        } catch (error) {
            log('warn', `Failed to read listing ${listing.url}: ${error.message}`);
        }

        await sleep(Math.max(400, Math.floor(opts.delay / 2)));
    }

    if (!opts.skipProfiles) {
        const profileTargets = Array.from(sellersMap.values())
            .filter((seller) => seller.profileUrl && /\/u\//i.test(seller.profileUrl))
            .slice(0, Math.max(0, opts.profileLimit));

        log('info', `\n── Enriching ${profileTargets.length} seller profile pages ──`);

        for (let index = 0; index < profileTargets.length; index++) {
            const seller = profileTargets[index];
            const profile = await getSellerProfile(browser, tabId, seller.profileUrl);
            const key = buildSellerKey(seller);
            sellersMap.set(key, mergeSellerRecord(seller, {
                name: profile.displayName,
                listingCount: profile.listingCount,
                memberSince: profile.memberSince,
                rating: profile.rating,
                reviews: profile.reviews,
                location: profile.location,
                isBusiness: profile.isBusiness,
                phone: profile.phone,
                website: profile.website,
            }));
            await sleep(Math.max(400, Math.floor(opts.delay / 2)));
        }
    }

    return {
        sellers: Array.from(sellersMap.values()),
        stats: {
            totalPages,
            totalListingsSeen,
            uniqueListings: listingMap.size,
            uniqueSellers: sellersMap.size,
            categories: opts.categories,
            scrapedAt: new Date().toISOString(),
        }
    };
}

function writeJson(data, outputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(outputDir, `sellers_${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    log('ok', `JSON written: ${filePath} (${data.sellers.length} sellers)`);
    return filePath;
}

function writeCsv(data, outputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(outputDir, `sellers_${ts}.csv`);

    const headers = [
        'name', 'profileUrl', 'location', 'listingCount', 'memberSince',
        'rating', 'reviews', 'isBusiness', 'phone', 'website', 'category',
        'sampleListing1', 'samplePrice1'
    ];

    const escape = (value) => {
        const text = String(value || '');
        if (text.includes(',') || text.includes('"') || text.includes('\n')) {
            return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
    };

    const rows = [headers.join(',')];
    for (const seller of data.sellers) {
        const sample = seller.sampleListings?.[0] || {};
        rows.push([
            escape(seller.name),
            escape(seller.profileUrl),
            escape(seller.location),
            seller.listingCount || '',
            escape(seller.memberSince),
            seller.rating || '',
            seller.reviews || '',
            seller.isBusiness ? 'yes' : '',
            escape(seller.phone),
            escape(seller.website),
            escape(seller.category),
            escape(sample.title),
            escape(sample.price),
        ].join(','));
    }

    fs.writeFileSync(filePath, rows.join('\n'), 'utf8');
    log('ok', `CSV written: ${filePath} (${data.sellers.length} sellers)`);
    return filePath;
}

async function main() {
    const opts = parseArgs(process.argv);

    if (!fs.existsSync(opts.output)) {
        fs.mkdirSync(opts.output, { recursive: true });
    }

    log('info', 'Marktplaats Seller Collector for checklot.nl');
    log('info', `Config: ${opts.pages} pages/category, ${opts.categories.length} categories, detail-limit=${opts.profileLimit}`);
    if (opts.skipProfiles) {
        log('info', 'Seller profile enrichment disabled; collecting inline listing seller details only.');
    }

    const data = await collectSellers(opts);

    data.sellers.sort((a, b) => {
        if (a.isBusiness !== b.isBusiness) {
            return b.isBusiness ? 1 : -1;
        }
        return (b.listingCount || 0) - (a.listingCount || 0);
    });

    if (opts.format === 'json' || opts.format === 'both') {
        writeJson(data, opts.output);
    }
    if (opts.format === 'csv' || opts.format === 'both') {
        writeCsv(data, opts.output);
    }

    log('info', '\n── Summary ──');
    log('info', `Total unique sellers: ${data.sellers.length}`);
    log('info', `Total unique listings: ${data.stats.uniqueListings}`);
    log('info', `Business sellers: ${data.sellers.filter((seller) => seller.isBusiness).length}`);
    log('info', `With phone: ${data.sellers.filter((seller) => seller.phone).length}`);
    log('info', `With website: ${data.sellers.filter((seller) => seller.website).length}`);
    log('info', `With 10+ listings: ${data.sellers.filter((seller) => seller.listingCount >= 10).length}`);

    const top = data.sellers.slice(0, 10);
    if (top.length) {
        log('info', '\nTop 10 sellers by listing count:');
        for (const seller of top) {
            log('info', `  ${seller.name || '(unknown)'} — ${seller.location || '?'} — ${seller.listingCount || '?'} listings${seller.isBusiness ? ' [BUSINESS]' : ''} ${seller.phone ? '📞' : ''} ${seller.website ? '🌐' : ''}`);
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        log('error', error.message);
        process.exit(1);
    });
}

module.exports = {
    MARKTPLAATS_BASE,
    CATEGORY_MAP,
    DEFAULT_CATEGORIES,
    parseArgs,
    parsePriceValue,
    canonicalizeListingUrl,
    buildSellerKey,
    mergeSellerRecord,
    parseInlineSellerSnapshot,
    hydrateMarktplaatsResults,
    extractListingSummariesFromCategoryPage,
    extractSubcategoryLinksFromHubPage,
    getNextPageUrl,
    collectSellers,
};
