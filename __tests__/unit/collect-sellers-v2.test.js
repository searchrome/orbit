const {
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
} = require('../../scripts/collect-sellers-v2.js');

describe('collect-sellers v2 helpers', () => {
    test('parses v2 cli args', () => {
        const flags = parseArgs([
            'node',
            'scripts/collect-sellers-v2.js',
            '--categories',
            'electronics,sieraden',
            '--pages',
            '4',
            '--visit-limit',
            '120'
        ]);

        expect(flags.categories).toEqual(['electronics', 'sieraden']);
        expect(flags.pages).toBe(4);
        expect(flags.visitLimit).toBe(120);
    });

    test('extracts contact info from free text', () => {
        const text = [
            'Bel ons: 088 435 5544',
            'Mail: naarden-tweedehands@hellotv.nl',
            'Website www.hellotv.nl',
            'Adres: 1411 AV Naarden'
        ].join('\n');

        expect(parseDutchPhoneNumbers(text)).toEqual(['088 435 5544']);
        expect(parseEmails(text)).toEqual(['naarden-tweedehands@hellotv.nl']);
        expect(parseWebsites(text)).toEqual(['www.hellotv.nl']);
        expect(parsePostalCodes(text)).toEqual(['1411 AV']);
    });

    test('normalizes action labels and filters useful external sites', () => {
        expect(normalizeActionLabel('Web ite')).toBe('webite');
        expect(matchesSidebarAction('website', 'Web ite')).toBe(true);
        expect(normalizeActionLabel('Toon nummer')).toBe('toonnummer');
        expect(matchesSidebarAction('phone', 'Toon nummer')).toBe(true);
        expect(isUsefulExternalWebsite('https://www.hellotv.nl/tweedehands')).toBe(true);
        expect(isUsefulExternalWebsite('https://duckduckgo.com/?q=0884355544')).toBe(false);
        expect(collectExternalContactUrls([
            'https://www.hellotv.nl/tweedehands',
            'https://duckduckgo.com/?q=0884355544',
            'https://www.hellotv.nl/tweedehands'
        ])).toEqual(['https://www.hellotv.nl/tweedehands']);
    });

    test('extracts listing city from viewed/ad timing block', () => {
        const text = [
            'Lochem',
            '4.682x bekeken',
            '32x bewaard',
            "Sinds 9 apr '25"
        ].join('\n');

        expect(extractLocationFromText(text)).toBe('Lochem');
    });

    test('prefers extracted city but falls back when it equals seller name', () => {
        expect(resolveLeadCity({
            extractedCity: 'MediaMarkt',
            fallbackCity: 'Amsterdam',
            sellerName: 'MediaMarkt',
        })).toBe('Amsterdam');

        expect(resolveLeadCity({
            extractedCity: 'Naarden',
            fallbackCity: 'Amsterdam',
            sellerName: 'HelloTV Den Bosch',
        })).toBe('Naarden');
    });

    test('builds lead key from profile url or seller identity', () => {
        expect(leadKey({
            profileUrl: 'https://www.marktplaats.nl/v/item#verkoper',
            sellerName: 'HelloTV Naarden',
            city: 'Naarden',
            memberSince: '3 jaar op Marktplaats'
        })).toBe(
            'hellotv naarden|naarden|3 jaar op marktplaats'
        );
        expect(leadKey({
            profileUrl: 'https://www.marktplaats.nl/u/123',
            sellerName: 'HelloTV Naarden',
            city: 'Naarden',
            memberSince: '3 jaar op Marktplaats'
        })).toBe('https://www.marktplaats.nl/u/123');
    });

    test('scores direct-contact business leads higher', () => {
        const bare = scoreLead({
            sellerName: 'Seller',
            phoneNumbers: [],
            emails: [],
            websites: [],
            websiteButtonVisible: false,
            city: '',
            memberSince: '',
            reviewCount: 0,
            isBusinessLikely: false,
        });
        const rich = scoreLead({
            sellerName: 'HelloTV Naarden',
            phoneNumbers: ['088 435 5544'],
            emails: ['naarden-tweedehands@hellotv.nl'],
            websites: ['www.hellotv.nl'],
            websiteButtonVisible: true,
            city: 'Naarden',
            memberSince: '3 jaar op Marktplaats',
            reviewCount: 161,
            isBusinessLikely: true,
        });

        expect(rich).toBeGreaterThan(bare);
    });
});
