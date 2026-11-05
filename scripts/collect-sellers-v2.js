#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { CdpBrowserSession } = require('./cdp-browser-session.js');
const {
    MARKTPLAATS_BASE,
    CATEGORY_MAP,
    canonicalizeListingUrl,
    hydrateMarktplaatsResults,
    extractListingSummariesFromCategoryPage,
    extractSubcategoryLinksFromHubPage,
    getNextPageUrl,
} = require('./collect-sellers.js');

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        categories: ['electronics'],
        pages: 3,
        visitLimit: 80,
        output: path.join(__dirname, 'logs'),
        format: 'both',
        port: 9222,
        delay: 1500,
        resumeState: '',
    };

    for (let index = 0; index < args.length; index++) {
        switch (args[index]) {
            case '--categories':
                opts.categories = args[++index].split(',').map((value) => value.trim()).filter(Boolean);
                break;
            case '--pages':
                opts.pages = parseInt(args[++index], 10);
                break;
            case '--visit-limit':
                opts.visitLimit = parseInt(args[++index], 10);
                break;
            case '--output':
                opts.output = args[++index];
                break;
            case '--format':
                opts.format = args[++index];
                break;
            case '--port':
                opts.port = parseInt(args[++index], 10);
                break;
            case '--delay':
                opts.delay = parseInt(args[++index], 10);
                break;
            case '--resume-state':
                opts.resumeState = args[++index];
                break;
        }
    }

    return opts;
}

function ensureParentDir(filePath) {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function loadJsonFile(filePath, fallbackValue) {
    if (!filePath || !fs.existsSync(filePath)) {
        return fallbackValue;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        log('warn', `Failed to read JSON file ${filePath}: ${error.message}`);
        return fallbackValue;
    }
}

function createEmptyResumeState() {
    return {
        version: 1,
        seenListingUrls: [],
        seenLeadKeys: [],
        runs: [],
        updatedAt: '',
    };
}

function normalizeResumeState(rawState) {
    const state = rawState && typeof rawState === 'object' ? rawState : {};
    return {
        version: 1,
        seenListingUrls: Array.isArray(state.seenListingUrls) ? state.seenListingUrls.filter(Boolean) : [],
        seenLeadKeys: Array.isArray(state.seenLeadKeys) ? state.seenLeadKeys.filter(Boolean) : [],
        runs: Array.isArray(state.runs) ? state.runs : [],
        updatedAt: normalizeWhitespace(state.updatedAt),
    };
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

function normalizeActionLabel(value) {
    return normalizeWhitespace(value).replace(/\s+/g, '').toLowerCase();
}

function matchesSidebarAction(actionName, value) {
    const label = normalizeActionLabel(value);
    if (actionName === 'website') {
        return /web.?ite/.test(label);
    }
    if (actionName === 'phone') {
        return /toonnummer/.test(label);
    }
    return false;
}

function parseDutchPhoneNumbers(text) {
    const lines = String(text || '').split(/\n+/).map(normalizeWhitespace).filter(Boolean);
    const normalized = [];
    const seen = new Set();
    for (const line of lines) {
        if (!/(?:bel|telefoon|tel\.?|mobiel|whatsapp)/i.test(line) && !/^(?:\+31|0)[\d\s()-]{8,}$/.test(line)) {
            continue;
        }
        const matches = line.match(/(?:\+31\s?\(0\)\s?|\+31\s?|0)(?:\d[\s()-]?){8,12}\d/g) || [];
        for (const match of matches) {
            const compact = match.replace(/[^\d+]/g, '');
            if (compact.length < 10) continue;
            if (seen.has(compact)) continue;
            seen.add(compact);
            normalized.push(match.replace(/\s+/g, ' ').trim());
        }
    }
    return normalized;
}

function parseEmails(text) {
    const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return Array.from(new Set(matches.map((value) => value.toLowerCase())));
}

function parseWebsites(text) {
    const matches = String(text || '').match(/(?:https?:\/\/|www\.)[^\s)>"']+/gi) || [];
    return Array.from(new Set(matches.map((value) => value.replace(/[.,;:!?]+$/, ''))));
}

function isUsefulExternalWebsite(value) {
    const url = normalizeWhitespace(value);
    if (!/^https?:\/\//i.test(url) && !/^www\./i.test(url)) {
        return false;
    }
    return !/marktplaats\.nl|duckduckgo\.com|google\.[^/]+\/search|bing\.com\/search/i.test(url);
}

function parsePostalCodes(text) {
    const matches = String(text || '').match(/\b\d{4}\s?[A-Z]{2}\b/g) || [];
    return Array.from(new Set(matches));
}

function extractLocationFromText(text) {
    const lines = String(text || '').split(/\n+/).map(normalizeWhitespace).filter(Boolean);
    const noise = /^(?:help en info|voorwaarden|veiligheidscentrum|berichten|meldingen|inloggen|plaats advertentie|zoek|home|bewaar|delen|bericht|toon nummer|website|waardering)$/i;
    for (const line of lines) {
        const match = line.match(/\b\d{4}\s?[A-Z]{2}\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})\b/);
        if (match && !noise.test(match[1])) {
            return match[1].trim();
        }
    }
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (noise.test(line)) continue;
        if (!/^(?:[A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,40})$/.test(line)) continue;
        const next = lines[index + 1] || '';
        const prev = lines[index - 1] || '';
        if (/bekeken|bewaard|op marktplaats|review|advertentienummer/i.test(next) || /^Sinds\b/i.test(prev) || /^Sinds\b/i.test(next)) {
            return line;
        }
    }
    return '';
}

function resolveLeadCity({ extractedCity, fallbackCity, sellerName }) {
    const normalizedSeller = normalizeWhitespace(sellerName).toLowerCase();
    const candidates = [extractedCity, fallbackCity];
    for (const candidate of candidates) {
        const city = normalizeWhitespace(candidate);
        if (!city) continue;
        if (normalizedSeller && city.toLowerCase() === normalizedSeller) {
            continue;
        }
        return city;
    }
    return '';
}

function collectExternalContactUrls(urls) {
    return Array.from(new Set((Array.isArray(urls) ? urls : [])
        .map((value) => normalizeWhitespace(value))
        .filter(isUsefulExternalWebsite)));
}

function leadKey(lead) {
    const directKey = normalizeWhitespace(lead.profileUrl).toLowerCase();
    if (directKey && /\/u\/|\/experiences\//i.test(directKey) && !/#verkoper$/i.test(directKey)) {
        return directKey;
    }
    return [
        normalizeWhitespace(lead.sellerName).toLowerCase(),
        normalizeWhitespace(lead.city).toLowerCase(),
        normalizeWhitespace(lead.memberSince).toLowerCase()
    ].join('|');
}

function scoreLead(lead) {
    let score = 0;
    if (lead.sellerName) score += 20;
    if (lead.phoneNumbers.length) score += 35;
    if (lead.emails.length) score += 35;
    if (lead.websites.length) score += 20;
    if (lead.websiteButtonVisible) score += 10;
    if (lead.city) score += 10;
    if (lead.memberSince) score += 5;
    if (lead.reviewCount > 0) score += 5;
    if (lead.isBusinessLikely) score += 15;
    return score;
}

function buildFallbackPageUrl(pageUrl, targetPage) {
    if (!pageUrl || !Number.isInteger(targetPage) || targetPage < 2) {
        return null;
    }

    try {
        const parsed = new URL(pageUrl);

        // /l/ pages use /p/N/ path-based pagination
        if (parsed.pathname.startsWith('/l/')) {
            const basePath = parsed.pathname.replace(/\/p\/\d+\//, '/').replace(/\/+$/, '');
            parsed.pathname = `${basePath}/p/${targetPage}/`;
            parsed.search = '';
            return parsed.toString();
        }

        // /cp/ hub pages don't support pagination at all — skip
        if (/\/cp\/\d+\//.test(parsed.pathname)) {
            return null;
        }

        if (parsed.searchParams.has('currentPage')) {
            parsed.searchParams.set('currentPage', String(targetPage));
            return parsed.toString();
        }
        if (parsed.searchParams.has('page')) {
            parsed.searchParams.set('page', String(targetPage));
            return parsed.toString();
        }
        parsed.searchParams.set('currentPage', String(targetPage));
        return parsed.toString();
    } catch {
        return null;
    }
}

function normalizePageQueueUrl(pageUrl) {
    const raw = normalizeWhitespace(pageUrl);
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return raw.split('#')[0];
    }
}

async function extractPaginationUrls(browser, tabId) {
    const payload = await browser.evaluate(tabId, `(() => {
        const hrefs = Array.from(document.querySelectorAll('a[href]'))
            .map((node) => node.href || node.getAttribute('href') || '')
            .filter(Boolean);
        return hrefs.filter((href) => /(?:currentPage|page)=\\d+/i.test(href) || /\/p\/\\d+\//.test(href));
    })()`, { timeoutMs: 5000 });

    const urls = Array.from(new Set((Array.isArray(payload) ? payload : [])
        .map((value) => normalizePageQueueUrl(value))
        .filter(Boolean)));

    urls.sort((left, right) => {
        const leftPage = Number(left.match(/(?:currentPage|page)=(\d+)/i)?.[1] || 0);
        const rightPage = Number(right.match(/(?:currentPage|page)=(\d+)/i)?.[1] || 0);
        return leftPage - rightPage;
    });

    return urls;
}

async function snapshotSidebarState(browser, tabId) {
    return browser.evaluate(tabId, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const root = document.querySelector('#seller-sidebar-root');
        return {
            currentUrl: location.href,
            sidebarText: String(root?.innerText || ''),
            bodyText: String(document.body?.innerText || ''),
            sidebarLinks: Array.from(root?.querySelectorAll('a[href]') || []).map((node) => node.href || node.getAttribute('href') || '').filter(Boolean),
            sidebarButtons: Array.from(root?.querySelectorAll('button,a') || []).map((node) => normalize(node.innerText || node.textContent))
        };
    })()`, { timeoutMs: 15000 });
}

async function tagSidebarAction(browser, tabId, actionName) {
    return browser.evaluate(tabId, `(() => {
        const actionName = ${JSON.stringify(String(actionName || ''))};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().replace(/\\s+/g, '').toLowerCase();
        const root = document.querySelector('#seller-sidebar-root');
        if (!root) {
            return { ok: false, error: 'Seller sidebar not found.' };
        }
        const buttons = Array.from(root.querySelectorAll('button,a'));
        const target = buttons.find((node) => {
            const label = normalize(node.innerText || node.textContent || '');
            return actionName === 'website' ? /web.?ite/.test(label) : /toonnummer/.test(label);
        });
        if (!target) {
            return { ok: false, error: 'Action button not found.' };
        }
        target.setAttribute('data-codex-seller-action', actionName);
        return { ok: true, selector: '[data-codex-seller-action="' + actionName + '"]' };
    })()`, { timeoutMs: 10000 });
}

async function clearSidebarActionTag(browser, tabId, actionName) {
    try {
        await browser.evaluate(tabId, `(() => {
            const actionName = ${JSON.stringify(String(actionName || ''))};
            const node = document.querySelector('[data-codex-seller-action="' + actionName + '"]');
            if (node) {
                node.removeAttribute('data-codex-seller-action');
            }
            return true;
        })()`, { timeoutMs: 5000 });
    } catch {
        // Best effort.
    }
}

async function revealSidebarAction(browser, tabId, actionName) {
    const tagged = await tagSidebarAction(browser, tabId, actionName);
    if (!tagged?.ok || !tagged.selector) {
        return { ok: false, actionName, error: tagged?.error || 'Action button not found.' };
    }

    const beforeTabs = await browser.refreshTargets();
    const beforeIds = new Set(beforeTabs.map((tab) => tab.id));
    const before = await snapshotSidebarState(browser, tabId);

    const clickResult = await browser.trustedClickElement({ tabId, selector: tagged.selector, index: 0 });
    await clearSidebarActionTag(browser, tabId, actionName);
    if (!clickResult?.ok) {
        return { ok: false, actionName, error: clickResult?.error || 'Trusted click failed.' };
    }

    await sleep(2500);
    const after = await snapshotSidebarState(browser, tabId);
    const afterTabs = await browser.refreshTargets();
    const newTabs = afterTabs.filter((tab) => !beforeIds.has(tab.id));
    const newExternalUrls = collectExternalContactUrls(newTabs.map((tab) => tab.url));

    for (const tab of newTabs) {
        try {
            await browser.closeTab({ tabId: tab.id });
        } catch {
            // Best effort cleanup.
        }
    }

    return {
        ok: true,
        actionName,
        before,
        after,
        newExternalUrls: collectExternalContactUrls([
            ...newExternalUrls,
            after?.currentUrl
        ])
    };
}

async function extractLeadFromListing(browser, tabId, listing) {
    await browser.navigate(tabId, listing.url);
    await sleep(1200);

    const snapshot = await browser.evaluate(tabId, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const sidebar = document.querySelector('#seller-sidebar-root');
        const bodyText = String(document.body?.innerText || '');
        const sidebarText = String(sidebar?.innerText || '');
        const sidebarLinks = Array.from(sidebar?.querySelectorAll('a[href]') || []).map((node) => ({
            text: normalize(node.innerText || node.textContent),
            href: node.href || node.getAttribute('href') || ''
        }));
        const sidebarButtons = Array.from(sidebar?.querySelectorAll('button,a') || []).map((node) => normalize(node.innerText || node.textContent));
        const sellerName = normalize(sidebar?.querySelector('.SellerInfoSmall-name a')?.innerText || '');
        const memberSince = normalize(Array.from(sidebar?.querySelectorAll('.SellerInfoSmall-row') || []).map((node) => normalize(node.innerText || node.textContent)).find((line) => /jaar op Marktplaats|maand op Marktplaats/i.test(line)) || '');
        const reviewLine = normalize(Array.from(sidebar?.querySelectorAll('.SellerInfoSmall-row') || []).map((node) => normalize(node.innerText || node.textContent)).find((line) => /review/i.test(line)) || '');
        const reviewMatch = reviewLine.match(/(\\d+(?:[.,]\\d+)?)\\s*[·•]\\s*(\\d+)\\s*reviews?/i) || reviewLine.match(/(\\d+)\\s*reviews?/i);
        const price = normalize(sidebar?.querySelector('.ListingHeader-price')?.innerText || '');
        const delivery = normalize(sidebar?.querySelector('.ShippingInformation-root')?.innerText || '');
        const profileUrl = sidebarLinks.find((item) => /#verkoper$|\\/u\\//i.test(item.href))?.href || '';
        return {
            title: normalize(sidebar?.querySelector('.ListingHeader-title')?.innerText || document.querySelector('h1')?.innerText || document.title),
            bodyText,
            sidebarText,
            sidebarLinks,
            sidebarButtons,
            sellerName,
            memberSince,
            reviewLine,
            reviewRating: reviewMatch && reviewMatch[2] ? reviewMatch[1] : '',
            reviewCount: reviewMatch && reviewMatch[2] ? parseInt(reviewMatch[2], 10) : (reviewMatch ? parseInt(reviewMatch[1], 10) : 0),
            price,
            delivery,
            profileUrl,
            descriptionText: normalize(document.body?.innerText || '').slice(0, 12000)
        };
    })()`, { timeoutMs: 15000 });

    const phoneReveal = await revealSidebarAction(browser, tabId, 'phone').catch(() => null);
    const websiteReveal = await revealSidebarAction(browser, tabId, 'website').catch(() => null);

    const combinedText = [
        snapshot.bodyText,
        snapshot.sidebarText,
        phoneReveal?.after?.sidebarText,
        phoneReveal?.after?.bodyText,
        websiteReveal?.after?.sidebarText,
        websiteReveal?.after?.bodyText
    ].filter(Boolean).join('\n');

    const phones = parseDutchPhoneNumbers(combinedText);
    const emails = parseEmails(combinedText);
    const inlineWebsites = parseWebsites(combinedText).filter(isUsefulExternalWebsite);
    const linkedWebsites = [
        ...(Array.isArray(snapshot.sidebarLinks) ? snapshot.sidebarLinks : []),
        ...(Array.isArray(phoneReveal?.after?.sidebarLinks) ? phoneReveal.after.sidebarLinks : []),
        ...(Array.isArray(websiteReveal?.after?.sidebarLinks) ? websiteReveal.after.sidebarLinks : []),
    ].filter(isUsefulExternalWebsite);
    const websites = Array.from(new Set([
        ...inlineWebsites,
        ...linkedWebsites,
        ...(websiteReveal?.newExternalUrls || [])
    ]));
    const postalCodes = parsePostalCodes(combinedText);
    const city = resolveLeadCity({
        extractedCity: extractLocationFromText(combinedText),
        fallbackCity: listing.location,
        sellerName: snapshot.sellerName || listing.sellerName || '',
    });
    const websiteButtonVisible = snapshot.sidebarButtons.some((value) => matchesSidebarAction('website', value));
    const phoneButtonVisible = snapshot.sidebarButtons.some((value) => matchesSidebarAction('phone', value));
    const isBusinessLikely = Boolean(
        websiteButtonVisible ||
        phones.length ||
        emails.length ||
        websites.length ||
        /webshop|shop|bv|b\.v\.|winkel|garantie|zakelijk/i.test(snapshot.sellerName) ||
        /bezoek aan onze winkel|7 dagen per week geopend|bel ons|klik op "bekijk meer advertenties"/i.test(combinedText)
    );

    const lead = {
        sellerName: snapshot.sellerName || listing.sellerName || '',
        profileUrl: snapshot.profileUrl,
        city,
        postalCodes,
        memberSince: snapshot.memberSince,
        rating: snapshot.reviewRating || '',
        reviewCount: Number(snapshot.reviewCount) || 0,
        listingTitle: snapshot.title || listing.title,
        listingUrl: canonicalizeListingUrl(listing.url),
        listingPrice: snapshot.price || listing.price || '',
        delivery: snapshot.delivery || '',
        phoneNumbers: phones,
        emails,
        websites,
        websiteButtonVisible,
        phoneButtonVisible,
        isBusinessLikely,
        category: listing.category,
        sourcePage: listing.sourcePage,
        sourceSubcategory: listing.sourceSubcategory || '',
        score: 0,
    };
    lead.score = scoreLead(lead);
    return lead;
}

async function collectLeadsV2(opts) {
    const resumeState = normalizeResumeState(loadJsonFile(opts.resumeState, createEmptyResumeState()));
    const seenListingUrls = new Set(resumeState.seenListingUrls);
    const seenLeadKeys = new Set(resumeState.seenLeadKeys);
    const browser = new CdpBrowserSession({ baseUrl: `http://127.0.0.1:${opts.port}` });
    await browser.initialize();

    try {
        const { tab } = await browser.openTab({ url: 'about:blank', activate: true });
        const tabId = tab.id;

        const listingMap = new Map();
        const leadMap = new Map();
        let hubPagesVisited = 0;
        let listingPagesVisited = 0;
        let skippedSeenListings = 0;
        let skippedSeenLeads = 0;

        for (const category of opts.categories) {
            const categoryPath = CATEGORY_MAP[category];
            if (!categoryPath) {
                log('warn', `Unknown category "${category}", skipping.`);
                continue;
            }

            const queue = [`${MARKTPLAATS_BASE}${categoryPath}`];
            const queued = new Set(queue);
            const visited = new Set();
            let listingPageCount = 0;

            log('info', `\n── Category v2: ${category} ──`);

            while (queue.length && listingPageCount < opts.pages) {
                const pageUrl = queue.shift();
                if (!pageUrl || visited.has(pageUrl)) continue;
                visited.add(pageUrl);

                const isHubPage = /\/cp\/\d+\//.test(pageUrl);

                await browser.navigate(tabId, pageUrl);
                await sleep(opts.delay);
                const hydratedCount = await hydrateMarktplaatsResults(browser, tabId, opts.delay);
                const listings = await extractListingSummariesFromCategoryPage(browser, tabId);

                // Hub pages (/cp/) don't support pagination — always discover subcategories
                if (listings.length === 0 || isHubPage) {
                    const subcategories = await extractSubcategoryLinksFromHubPage(browser, tabId, category);
                    if (subcategories.length > 0) {
                        hubPagesVisited++;
                        log('info', `  Hub page: ${pageUrl} → ${subcategories.length} subcategories`);
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

                listingPagesVisited++;
                listingPageCount++;
                log('ok', `  Listing page ${listingPageCount}/${opts.pages}: ${pageUrl} → ${hydratedCount} hydrated links, ${listings.length} extracted`);
                for (const listing of listings) {
                    const listingUrl = canonicalizeListingUrl(listing.url);
                    if (!listingUrl || listingMap.has(listingUrl)) continue;
                    if (seenListingUrls.has(listingUrl)) {
                        skippedSeenListings++;
                        continue;
                    }
                    listingMap.set(listingUrl, {
                        ...listing,
                        url: listingUrl,
                        category,
                        sourcePage: pageUrl,
                        sourceSubcategory: pageUrl.includes('/l/') ? pageUrl : ''
                    });
                }

                const nextUrl = await getNextPageUrl(browser, tabId);
                const paginationUrls = await extractPaginationUrls(browser, tabId);
                const fallbackPageUrl = buildFallbackPageUrl(pageUrl, listingPageCount + 1);
                const queueCandidates = [
                    normalizePageQueueUrl(nextUrl),
                    ...paginationUrls.map((value) => normalizePageQueueUrl(value)),
                    normalizePageQueueUrl(fallbackPageUrl),
                ];

                let queuedCount = 0;
                for (const candidateUrl of queueCandidates) {
                    if (!candidateUrl || queued.has(candidateUrl) || visited.has(candidateUrl) || listingPageCount >= opts.pages) {
                        continue;
                    }
                    queue.push(candidateUrl);
                    queued.add(candidateUrl);
                    queuedCount++;
                }

                log('info', `  Discovery: ${listingMap.size} unique listings, ${skippedSeenListings} seen skipped, ${queue.length} queued pages, next=${nextUrl || 'none'}, added=${queuedCount}`);
                if (!nextUrl && paginationUrls.length === 0 && !fallbackPageUrl) {
                    log('warn', `  No pagination URL detected on ${pageUrl}`);
                }
            }
        }

        const listingsToVisit = Array.from(listingMap.values()).slice(0, Math.max(1, opts.visitLimit));
        log('info', `\n── Visiting ${listingsToVisit.length} listings for v2 lead extraction (${listingMap.size} discovered, ${skippedSeenListings} seen skipped) ──`);

        for (let index = 0; index < listingsToVisit.length; index++) {
            const listing = listingsToVisit[index];
            if (index > 0 && index % 10 === 0) {
                log('info', `  Progress: ${index}/${listingsToVisit.length} listing visits`);
            }

            try {
                const lead = await extractLeadFromListing(browser, tabId, listing);
                const key = leadKey(lead);
                if (!key) continue;
                if (seenLeadKeys.has(key)) {
                    skippedSeenLeads++;
                    continue;
                }
                const existing = leadMap.get(key);
                if (!existing || lead.score > existing.score) {
                    leadMap.set(key, lead);
                }
            } catch (error) {
                log('warn', `Failed to extract lead from ${listing.url}: ${error.message}`);
            }

            await sleep(Math.max(300, Math.floor(opts.delay / 2)));
        }

        const leads = Array.from(leadMap.values()).sort((left, right) => right.score - left.score);
        for (const listing of listingsToVisit) {
            const listingUrl = normalizeWhitespace(listing?.url);
            if (!listingUrl) {
                continue;
            }
            seenListingUrls.add(listingUrl);
        }
        for (const lead of leads) {
            const key = leadKey(lead);
            if (key) {
                seenLeadKeys.add(key);
            }
        }

        const updatedResumeState = {
            version: 1,
            seenListingUrls: Array.from(seenListingUrls).sort(),
            seenLeadKeys: Array.from(seenLeadKeys).sort(),
            runs: [
                ...resumeState.runs,
                {
                    scrapedAt: new Date().toISOString(),
                    categories: opts.categories,
                    pages: opts.pages,
                    visitLimit: opts.visitLimit,
                    newListingsQueued: listingMap.size,
                    visitedListings: listingsToVisit.length,
                    newLeads: leads.length,
                    skippedSeenListings,
                    skippedSeenLeads,
                }
            ].slice(-50),
            updatedAt: new Date().toISOString(),
        };
        const stats = {
            categories: opts.categories,
            hubPagesVisited,
            listingPagesVisited,
            uniqueListings: listingMap.size,
            visitedListings: listingsToVisit.length,
            uniqueLeads: leads.length,
            skippedSeenListings,
            skippedSeenLeads,
            leadsWithPhone: leads.filter((lead) => lead.phoneNumbers.length > 0).length,
            leadsWithEmail: leads.filter((lead) => lead.emails.length > 0).length,
            leadsWithWebsite: leads.filter((lead) => lead.websites.length > 0).length,
            leadsWithContactButton: leads.filter((lead) => lead.websiteButtonVisible || lead.phoneButtonVisible).length,
            leadsWithDirectContact: leads.filter((lead) => lead.phoneNumbers.length > 0 || lead.emails.length > 0 || lead.websites.length > 0).length,
            businessLikely: leads.filter((lead) => lead.isBusinessLikely).length,
            contactPointRate: leads.length ? Number(((leads.filter((lead) => lead.phoneNumbers.length > 0 || lead.emails.length > 0 || lead.websites.length > 0).length / leads.length) * 100).toFixed(1)) : 0,
            contactActionRate: leads.length ? Number(((leads.filter((lead) => lead.websiteButtonVisible || lead.phoneButtonVisible).length / leads.length) * 100).toFixed(1)) : 0,
            sellerYieldRate: listingsToVisit.length ? Number(((leads.length / listingsToVisit.length) * 100).toFixed(1)) : 0,
            scrapedAt: new Date().toISOString(),
        };

        return { leads, stats, resumeState: updatedResumeState };
    } finally {
        await browser.close();
    }
}

function writeJson(data, outputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(outputDir, `seller_leads_v2_${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return filePath;
}

function writeCsv(data, outputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = path.join(outputDir, `seller_leads_v2_${ts}.csv`);
    const headers = [
        'sellerName', 'city', 'postalCodes', 'memberSince', 'rating', 'reviewCount',
        'phoneNumbers', 'emails', 'websites', 'websiteButtonVisible', 'phoneButtonVisible', 'isBusinessLikely',
        'listingTitle', 'listingPrice', 'listingUrl', 'category', 'score'
    ];
    const escape = (value) => {
        const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [headers.join(',')];
    for (const lead of data.leads) {
        rows.push([
            escape(lead.sellerName),
            escape(lead.city),
            escape(lead.postalCodes),
            escape(lead.memberSince),
            escape(lead.rating),
            escape(lead.reviewCount),
            escape(lead.phoneNumbers),
            escape(lead.emails),
            escape(lead.websites),
            escape(lead.websiteButtonVisible ? 'yes' : ''),
            escape(lead.phoneButtonVisible ? 'yes' : ''),
            escape(lead.isBusinessLikely ? 'yes' : ''),
            escape(lead.listingTitle),
            escape(lead.listingPrice),
            escape(lead.listingUrl),
            escape(lead.category),
            escape(lead.score),
        ].join(','));
    }
    fs.writeFileSync(filePath, rows.join('\n'), 'utf8');
    return filePath;
}

function writeResumeState(state, filePath) {
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    return filePath;
}

async function main() {
    const opts = parseArgs(process.argv);
    if (!fs.existsSync(opts.output)) {
        fs.mkdirSync(opts.output, { recursive: true });
    }

    log('info', `Seller collector v2 starting: categories=${opts.categories.join(', ')} pages=${opts.pages} visitLimit=${opts.visitLimit}`);
    const data = await collectLeadsV2(opts);

    if (opts.resumeState) {
        const statePath = writeResumeState(data.resumeState, opts.resumeState);
        log('ok', `Resume state written: ${statePath}`);
    }

    if (opts.format === 'json' || opts.format === 'both') {
        const filePath = writeJson(data, opts.output);
        log('ok', `JSON written: ${filePath} (${data.leads.length} leads)`);
    }
    if (opts.format === 'csv' || opts.format === 'both') {
        const filePath = writeCsv(data, opts.output);
        log('ok', `CSV written: ${filePath} (${data.leads.length} leads)`);
    }
    log('info', `Seller-yield rate: ${data.stats.sellerYieldRate}% (${data.stats.uniqueLeads}/${data.stats.visitedListings})`);
    log('info', `Direct contact-point rate: ${data.stats.contactPointRate}%`);
    log('info', `Contact-action rate: ${data.stats.contactActionRate}%`);
    log('info', `Leads with phone: ${data.stats.leadsWithPhone}`);
    log('info', `Leads with email: ${data.stats.leadsWithEmail}`);
    log('info', `Leads with website: ${data.stats.leadsWithWebsite}`);
    log('info', `Leads with contact button: ${data.stats.leadsWithContactButton}`);
    log('info', `Business-likely leads: ${data.stats.businessLikely}`);
    if (opts.resumeState) {
        log('info', `Skipped seen listings: ${data.stats.skippedSeenListings}`);
        log('info', `Skipped seen leads: ${data.stats.skippedSeenLeads}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        log('error', error.message);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    normalizeActionLabel,
    matchesSidebarAction,
    parseDutchPhoneNumbers,
    parseEmails,
    parseWebsites,
    isUsefulExternalWebsite,
    parsePostalCodes,
    extractLocationFromText,
    resolveLeadCity,
    collectExternalContactUrls,
    scoreLead,
    leadKey,
    collectLeadsV2,
};
