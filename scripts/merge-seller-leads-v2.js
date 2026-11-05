#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        inputDir: path.join(__dirname, 'logs'),
        output: '',
        includePattern: /^seller_leads_v2_\d{4}-\d{2}-\d{2}T.*\.json$/i,
    };

    for (let index = 0; index < args.length; index++) {
        switch (args[index]) {
            case '--input-dir':
                opts.inputDir = args[++index];
                break;
            case '--output':
                opts.output = args[++index];
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

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean)));
}

function mergeScalar(existingValue, nextValue) {
    return normalizeWhitespace(existingValue) || normalizeWhitespace(nextValue);
}

function leadMergeKey(lead) {
    const listingUrl = normalizeWhitespace(lead?.listingUrl);
    if (listingUrl) {
        return `listing:${listingUrl}`;
    }

    const profileUrl = normalizeWhitespace(lead?.profileUrl);
    if (profileUrl) {
        return `profile:${profileUrl}`;
    }

    return [
        normalizeWhitespace(lead?.sellerName).toLowerCase(),
        normalizeWhitespace(lead?.listingTitle).toLowerCase(),
        normalizeWhitespace(lead?.category).toLowerCase(),
    ].join('|');
}

function mergeLead(existing, incoming, sourceFile) {
    if (!existing) {
        return {
            ...incoming,
            phoneNumbers: uniqueStrings(incoming.phoneNumbers),
            emails: uniqueStrings(incoming.emails),
            websites: uniqueStrings(incoming.websites),
            postalCodes: uniqueStrings(incoming.postalCodes),
            sourceFiles: [sourceFile],
        };
    }

    return {
        sellerName: mergeScalar(existing.sellerName, incoming.sellerName),
        profileUrl: mergeScalar(existing.profileUrl, incoming.profileUrl),
        city: mergeScalar(existing.city, incoming.city),
        postalCodes: uniqueStrings([...(existing.postalCodes || []), ...(incoming.postalCodes || [])]),
        memberSince: mergeScalar(existing.memberSince, incoming.memberSince),
        rating: mergeScalar(existing.rating, incoming.rating),
        reviewCount: Math.max(Number(existing.reviewCount) || 0, Number(incoming.reviewCount) || 0),
        listingTitle: mergeScalar(existing.listingTitle, incoming.listingTitle),
        listingUrl: mergeScalar(existing.listingUrl, incoming.listingUrl),
        listingPrice: mergeScalar(existing.listingPrice, incoming.listingPrice),
        delivery: mergeScalar(existing.delivery, incoming.delivery),
        phoneNumbers: uniqueStrings([...(existing.phoneNumbers || []), ...(incoming.phoneNumbers || [])]),
        emails: uniqueStrings([...(existing.emails || []), ...(incoming.emails || [])]),
        websites: uniqueStrings([...(existing.websites || []), ...(incoming.websites || [])]),
        websiteButtonVisible: Boolean(existing.websiteButtonVisible || incoming.websiteButtonVisible),
        phoneButtonVisible: Boolean(existing.phoneButtonVisible || incoming.phoneButtonVisible),
        isBusinessLikely: Boolean(existing.isBusinessLikely || incoming.isBusinessLikely),
        category: mergeScalar(existing.category, incoming.category),
        sourcePage: mergeScalar(existing.sourcePage, incoming.sourcePage),
        sourceSubcategory: mergeScalar(existing.sourceSubcategory, incoming.sourceSubcategory),
        score: Math.max(Number(existing.score) || 0, Number(incoming.score) || 0),
        sourceFiles: uniqueStrings([...(existing.sourceFiles || []), sourceFile]),
    };
}

function escapeCsv(value) {
    const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function listInputFiles(inputDir, includePattern) {
    if (!fs.existsSync(inputDir)) {
        throw new Error(`Input directory does not exist: ${inputDir}`);
    }

    return fs.readdirSync(inputDir)
        .filter((name) => includePattern.test(name))
        .map((name) => path.join(inputDir, name))
        .sort();
}

function readLeadsFromFile(filePath) {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(payload?.leads) ? payload.leads : [];
}

function buildDefaultOutputPath(inputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return path.join(inputDir, `seller_leads_v2_merged_${ts}.csv`);
}

function writeCsv(leads, outputPath) {
    const headers = [
        'sellerName', 'profileUrl', 'city', 'postalCodes', 'memberSince', 'rating', 'reviewCount',
        'listingTitle', 'listingUrl', 'listingPrice', 'delivery',
        'phoneNumbers', 'emails', 'websites',
        'websiteButtonVisible', 'phoneButtonVisible', 'isBusinessLikely',
        'category', 'sourcePage', 'sourceSubcategory', 'score', 'sourceFiles'
    ];

    const rows = [headers.join(',')];
    for (const lead of leads) {
        rows.push([
            escapeCsv(lead.sellerName),
            escapeCsv(lead.profileUrl),
            escapeCsv(lead.city),
            escapeCsv(lead.postalCodes),
            escapeCsv(lead.memberSince),
            escapeCsv(lead.rating),
            escapeCsv(lead.reviewCount),
            escapeCsv(lead.listingTitle),
            escapeCsv(lead.listingUrl),
            escapeCsv(lead.listingPrice),
            escapeCsv(lead.delivery),
            escapeCsv(lead.phoneNumbers),
            escapeCsv(lead.emails),
            escapeCsv(lead.websites),
            escapeCsv(lead.websiteButtonVisible ? 'yes' : ''),
            escapeCsv(lead.phoneButtonVisible ? 'yes' : ''),
            escapeCsv(lead.isBusinessLikely ? 'yes' : ''),
            escapeCsv(lead.category),
            escapeCsv(lead.sourcePage),
            escapeCsv(lead.sourceSubcategory),
            escapeCsv(lead.score),
            escapeCsv(lead.sourceFiles),
        ].join(','));
    }

    fs.writeFileSync(outputPath, rows.join('\n'), 'utf8');
}

async function main() {
    const opts = parseArgs(process.argv);
    const inputFiles = listInputFiles(opts.inputDir, opts.includePattern);

    if (inputFiles.length === 0) {
        throw new Error(`No seller_leads_v2 result files found in ${opts.inputDir}`);
    }

    const merged = new Map();
    let totalRawLeads = 0;

    for (const filePath of inputFiles) {
        const leads = readLeadsFromFile(filePath);
        totalRawLeads += leads.length;
        const sourceFile = path.basename(filePath);
        for (const lead of leads) {
            const key = leadMergeKey(lead);
            if (!normalizeWhitespace(key)) {
                continue;
            }
            merged.set(key, mergeLead(merged.get(key), lead, sourceFile));
        }
    }

    const mergedLeads = Array.from(merged.values()).sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0));
    const outputPath = opts.output || buildDefaultOutputPath(opts.inputDir);
    writeCsv(mergedLeads, outputPath);

    log('ok', `CSV written: ${outputPath}`);
    log('info', `Input files: ${inputFiles.length}`);
    log('info', `Raw leads: ${totalRawLeads}`);
    log('info', `Merged leads: ${mergedLeads.length}`);
}

if (require.main === module) {
    main().catch((error) => {
        log('error', error.message);
        process.exit(1);
    });
}
