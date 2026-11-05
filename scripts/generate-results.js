#!/usr/bin/env node
'use strict';
const fs = require('fs');

const csv = fs.readFileSync(__dirname + '/logs/seller_leads_v2_merged_2026-06-05T12-30-36.csv', 'utf8');
const lines = csv.split('\n');
const header = lines[0].split(',');

const idx = {};
['sellerName','profileUrl','city','memberSince','rating','reviewCount','listingTitle','listingUrl','listingPrice','phoneNumbers','emails','websites','category'].forEach(h => {
    idx[h] = header.findIndex(col => col === h);
});

function parseCSVLine(line) {
    const fields = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQ = !inQ; continue; }
        if (line[i] === ',' && !inQ) { fields.push(cur.trim()); cur = ''; continue; }
        cur += line[i];
    }
    fields.push(cur.trim());
    return fields;
}

const rows = lines.slice(1).filter(l => l.trim());
const mobileLeads = [];
const websiteNoEmail = [];
const emailLeads = [];
const junkDomains = ['intel.com','dell.com','synology.com','eversolo.com','exsys.de'];

for (const line of rows) {
    const f = parseCSVLine(line);
    const lead = {};
    for (const [k, i] of Object.entries(idx)) { lead[k] = (f[i] || '').trim(); }

    const phones = lead.phoneNumbers.split('|').map(p => p.trim()).filter(Boolean);
    const mobiles = phones.filter(p => /^(?:\+31\s*6|06)/.test(p.replace(/[\s()-]/g, '')));
    const emails = lead.emails.split('|').map(e => e.trim()).filter(Boolean);
    const websites = lead.websites.split('|').map(w => w.trim()).filter(Boolean);
    const realEmails = emails.filter(e => !junkDomains.some(d => e.includes(d)));

    if (mobiles.length > 0) {
        mobileLeads.push({ ...lead, mobiles });
    }
    if (websites.length > 0 && realEmails.length === 0) {
        websiteNoEmail.push({ ...lead, websites });
    }
    if (realEmails.length > 0) {
        emailLeads.push({ ...lead, realEmails });
    }
}

let md = '# CDP Scraper Results — Marktplaats Seller Leads\n\n';
md += '**Date:** 2026-06-05\n';
md += '**Source:** Marktplaats.nl category scraper (collect-sellers-v2.js)\n';
md += '**Total merged leads:** 1,033\n\n';
md += '---\n\n';

md += `## 1. Sellers with Mobile Phone (${mobileLeads.length})\n\n`;
md += 'These sellers have a Dutch mobile number (06/+316) — reachable via call, SMS, or WhatsApp.\n\n';
md += '| Seller | Mobile | City | Category | Listing |\n';
md += '|--------|--------|------|----------|---------|\n';
for (const l of mobileLeads) {
    md += `| ${l.sellerName.slice(0,30)} | ${l.mobiles[0]} | ${l.city.slice(0,20)} | ${l.category.slice(0,20)} | ${l.listingTitle.replace(/\|/g,'/').slice(0,40)} |\n`;
}

md += '\n---\n\n';
md += `## 2. Sellers with Email (${emailLeads.length})\n\n`;
md += '| Seller | Email | City | Category |\n';
md += '|--------|-------|------|----------|\n';
for (const l of emailLeads) {
    md += `| ${l.sellerName.slice(0,30)} | ${l.realEmails.join(', ')} | ${l.city.slice(0,20)} | ${l.category.slice(0,20)} |\n`;
}

md += '\n---\n\n';
md += `## 3. Sellers with Website but NO Email (${websiteNoEmail.length})\n\n`;
md += 'These sellers have a website — visit to find contact forms or email addresses.\n\n';
md += '| Seller | Website | City | Category |\n';
md += '|--------|---------|------|----------|\n';
for (const l of websiteNoEmail) {
    md += `| ${l.sellerName.slice(0,30)} | ${l.websites[0].slice(0,60)} | ${l.city.slice(0,20)} | ${l.category.slice(0,20)} |\n`;
}

md += '\n---\n\n';
md += '## Summary\n\n';
md += '| Segment | Count |\n';
md += '|---------|-------|\n';
md += `| Mobile phone leads | ${mobileLeads.length} |\n`;
md += `| Email leads | ${emailLeads.length} |\n`;
md += `| Website (no email) | ${websiteNoEmail.length} |\n`;
md += '| Total unique leads | 1,033 |\n';

const outPath = '/Users/sozay/workspace/auctionmaster/docs/marketing/CDP_scraper_results.md';
fs.writeFileSync(outPath, md);
console.log('Written to:', outPath);
console.log('  Mobile leads:', mobileLeads.length);
console.log('  Email leads:', emailLeads.length);
console.log('  Website no email:', websiteNoEmail.length);

console.log('\n=== WEBSITES WITHOUT EMAIL ===');
websiteNoEmail.forEach(l => console.log(l.websites[0] + ' — ' + l.sellerName + (l.city ? ', ' + l.city : '')));
