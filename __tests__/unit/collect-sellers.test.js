const {
    parseArgs,
    parsePriceValue,
    canonicalizeListingUrl,
    buildSellerKey,
    mergeSellerRecord,
    parseInlineSellerSnapshot,
} = require('../../scripts/collect-sellers.js');

describe('collect-sellers helpers', () => {
    test('parses collector CLI flags', () => {
        const args = parseArgs([
            'node',
            'scripts/collect-sellers.js',
            '--categories',
            'kunst,sieraden',
            '--pages',
            '3',
            '--profile-limit',
            '25',
            '--skip-profiles'
        ]);

        expect(args.categories).toEqual(['kunst', 'sieraden']);
        expect(args.pages).toBe(3);
        expect(args.profileLimit).toBe(25);
        expect(args.skipProfiles).toBe(true);
    });

    test('canonicalizes listing urls and strips tracking parameters', () => {
        expect(
            canonicalizeListingUrl('https://www.marktplaats.nl/v/antiek-en-kunst/kunst/m123?c=abc&casData=1&utm_source=x#foo')
        ).toBe('https://www.marktplaats.nl/v/antiek-en-kunst/kunst/m123');
    });

    test('parses marketplace price strings', () => {
        expect(parsePriceValue('€ 150,00')).toBe(150);
        expect(parsePriceValue('EUR 1.250,50')).toBe(1250.5);
        expect(parsePriceValue('Bieden')).toBeNull();
    });

    test('builds seller keys from profile url or seller identity', () => {
        expect(buildSellerKey({ profileUrl: 'https://www.marktplaats.nl/u/example/123/' })).toBe(
            'https://www.marktplaats.nl/u/example/123/'
        );
        expect(buildSellerKey({ name: 'Hobbyist 2026', location: 'Oss' })).toBe('hobbyist 2026|oss');
    });

    test('parses inline seller snapshot from listing text', () => {
        const parsed = parseInlineSellerSnapshot({
            profileUrl: 'https://www.marktplaats.nl/v/item#verkoper',
            memberSince: '1 jaar op Marktplaats',
            rating: '4.0',
            reviews: 1,
            lines: [
                'nette batavus mambo herenfiets 53 cm 7 V',
                '€ 150,00',
                'Oss',
                "Sinds 2 jun '26",
                'Hobbyist 2026',
                '1 jaar op Marktplaats',
                '4.0 · 1 review',
                'Bericht'
            ]
        });

        expect(parsed.name).toBe('Hobbyist 2026');
        expect(parsed.location).toBe('Oss');
        expect(parsed.memberSince).toBe('1 jaar op Marktplaats');
        expect(parsed.rating).toBe('4.0');
        expect(parsed.reviews).toBe(1);
    });

    test('merges seller records without duplicating sample listings', () => {
        const merged = mergeSellerRecord({
            name: 'Seller',
            profileUrl: '',
            location: 'Oss',
            listingCount: 0,
            memberSince: '',
            rating: '',
            reviews: 0,
            isBusiness: false,
            phone: '',
            website: '',
            category: 'kunst',
            foundOnPage: 1,
            sampleListings: [{
                title: 'Listing A',
                url: 'https://www.marktplaats.nl/v/a',
                price: '€ 15,00'
            }]
        }, {
            rating: '4.5',
            reviews: 2,
            sampleListing: {
                title: 'Listing A',
                url: 'https://www.marktplaats.nl/v/a',
                price: '€ 15,00'
            }
        });

        expect(merged.rating).toBe('4.5');
        expect(merged.reviews).toBe(2);
        expect(merged.sampleListings).toHaveLength(1);
    });
});
