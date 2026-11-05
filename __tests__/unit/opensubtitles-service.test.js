const os = require('os');
const fs = require('fs');
const path = require('path');
const { OpenSubtitlesService } = require('../../opensubtitles-service');

// jest.setup.js stubs fs.promises for renderer-oriented tests; the credential
// roundtrip needs the real filesystem.
jest.unmock('fs');

function fakeSecretStorage() {
    return {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`enc:${value}`),
        decryptString: (buffer) => Buffer.from(buffer).toString('utf8').replace(/^enc:/, '')
    };
}

function makeService({ fetchImpl, secretStorage = fakeSecretStorage() } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osub-test-'));
    const app = { getPath: () => dir };
    return { service: new OpenSubtitlesService({ app, secretStorage, fetchImpl }), dir };
}

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

function textResponse(text) {
    return {
        ok: true,
        status: 200,
        text: async () => text,
        arrayBuffer: async () => Buffer.from(text, 'utf8')
    };
}

const SEARCH_RESPONSE = {
    data: [
        {
            attributes: {
                release: 'Show.S06E01.1080p',
                language: 'en',
                hearing_impaired: true,
                ai_translated: false,
                feature_details: { title: 'Show', year: 2016, season_number: 6, episode_number: 1 },
                files: [
                    { file_id: 777, file_name: 'Show.S06E01.zip' },
                    { file_id: 888, file_name: 'Show.S06E01.srt' }
                ]
            }
        },
        {
            attributes: {
                release: 'Show.Movie.720p',
                language: 'en',
                feature_details: { title: 'Show', year: null, season_number: null, episode_number: null },
                files: [{ file_id: 999, file_name: 'Show.Movie.720p.zip' }]
            }
        }
    ]
};

const DOWNLOAD_RESPONSE = { link: 'https://dl.example/sub.srt', file_name: 'Show.S06E01.srt' };

const SRT_BODY = '1\n00:00:01,000 --> 00:00:04,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,500\nGeneral Kenobi\n';

describe('OpenSubtitles service', () => {
    test('stores the API key encrypted and reports its status', async () => {
        const { service, dir } = makeService();
        const saved = await service.saveSettings({ openSubtitlesApiKey: 'my-secret-key' });
        expect(saved.openSubtitlesKeyConfigured).toBe(true);
        expect(saved.secureCredentialStorageAvailable).toBe(true);

        const raw = fs.readFileSync(path.join(dir, 'cast-credentials.json'), 'utf8');
        expect(raw).not.toContain('my-secret-key');

        const settings = await service.getSettings();
        expect(settings.openSubtitlesKeyConfigured).toBe(true);
    });

    test('clears the saved key', async () => {
        const { service } = makeService();
        await service.saveSettings({ openSubtitlesApiKey: 'k1' });
        const cleared = await service.saveSettings({ clearOpenSubtitlesApiKey: true });
        expect(cleared.openSubtitlesKeyConfigured).toBe(false);
    });

    test('cleans player titles for searching', () => {
        expect(OpenSubtitlesService.cleanSearchTitle('Watch Slow Horses - Season 6 Episode 1 - Watch Online | tvids'))
            .toBe('Slow Horses');
        expect(OpenSubtitlesService.cleanSearchTitle('Show S06E01 1080p WEB-DL'))
            .toBe('Show');
        expect(OpenSubtitlesService.cleanSearchTitle('A Movie (2019)')).toBe('A Movie');
    });

    test('extracts imdb id and season/episode from the page', () => {
        const meta = OpenSubtitlesService.extractEpisodeMeta(
            'https://site/watch1814/slow-horses/season-06-episode-01-circle-of-life',
            'Watch Slow Horses'
        );
        expect(meta).toEqual({ imdbId: '', season: 6, episode: 1 });

        const withImdb = OpenSubtitlesService.extractEpisodeMeta('https://x/embed/tv/tt5875444/6/1', '');
        expect(withImdb.imdbId).toBe('tt5875444');

        const sxe = OpenSubtitlesService.extractEpisodeMeta('', 'Show S03E12 title');
        expect(sxe).toEqual({ imdbId: '', season: 3, episode: 12 });
    });

    test('search returns a normalized, user-pickable result list', async () => {
        const calls = [];
        const fetchImpl = async (url, options = {}) => {
            calls.push({ url: String(url), headers: options.headers || {} });
            if (String(url).includes('/subtitles')) return jsonResponse(SEARCH_RESPONSE);
            return jsonResponse({});
        };
        const { service } = makeService({ fetchImpl });
        await service.saveSettings({ openSubtitlesApiKey: 'key-123' });

        const { results, searchedWith } = await service.search({ title: 'Slow Horses - Season 6', url: 'https://site/watch/tt5875444/6/1' });
        expect(searchedWith.imdb_id).toBe('5875444');
        expect(searchedWith.season_number).toBe(6);
        expect(searchedWith.episode_number).toBe(1);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({
            fileId: 888,
            label: 'Show.S06E01.1080p',
            language: 'en',
            feature: 'Show',
            season: 6,
            episode: 1,
            hearingImpaired: true
        });
        expect(results[1].fileId).toBe(999);
        expect(calls[0].headers['Api-Key']).toBe('key-123');
    });

    test('falls back to a query search when no imdb id exists', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(String(url));
            if (String(url).includes('/subtitles')) return jsonResponse(SEARCH_RESPONSE);
            return jsonResponse({});
        };
        const { service } = makeService({ fetchImpl });
        await service.saveSettings({ openSubtitlesApiKey: 'k' });
        const { searchedWith } = await service.search({ title: 'Some Show', url: '', query: 'My Own Query' });
        expect(searchedWith.query).toBe('My Own Query');
        expect(searchedWith.imdb_id).toBeUndefined();
    });

    test('downloads the chosen file and surfaces clear errors for dead files', async () => {
        let downloadCalls = 0;
        const fetchImpl = async (url) => {
            const href = String(url);
            if (href.includes('/download')) {
                downloadCalls += 1;
                if (downloadCalls === 1) {
                    return { ok: false, status: 404, text: async () => '{"status":404,"error":"Not Found"}', json: async () => ({}) };
                }
                return jsonResponse(DOWNLOAD_RESPONSE);
            }
            return textResponse(SRT_BODY);
        };
        const { service } = makeService({ fetchImpl });
        await service.saveSettings({ openSubtitlesApiKey: 'k' });

        await expect(service.downloadSrt(777)).rejects.toThrow('HTTP 404');
        const srt = await service.downloadSrt(777);
        expect(srt).toContain('General Kenobi');
        expect(downloadCalls).toBe(2);
    });

    test('rejects zip downloads with a clear message', async () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
        const fetchImpl = async (url) => {
            const href = String(url);
            if (href.includes('/download')) return jsonResponse(DOWNLOAD_RESPONSE);
            return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => bytes.buffer };
        };
        const { service } = makeService({ fetchImpl });
        await service.saveSettings({ openSubtitlesApiKey: 'k' });
        await expect(service.downloadSrt(888)).rejects.toThrow('zip');
    });

    test('lifts S/E markers out of a typed query into dedicated params', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(String(url));
            if (String(url).includes('/subtitles')) return jsonResponse(SEARCH_RESPONSE);
            return jsonResponse({});
        };
        const { service } = makeService({ fetchImpl });
        await service.saveSettings({ openSubtitlesApiKey: 'k' });

        const { searchedWith } = await service.search({ query: 'South Park S28E1 online TV Series', url: '' });
        expect(searchedWith.query).toBe('South Park');
        expect(searchedWith.season_number).toBe(28);
        expect(searchedWith.episode_number).toBe(1);
    });

    test('asks for the API key when none is configured', async () => {
        const { service } = makeService({ fetchImpl: async () => jsonResponse({}) });
        await expect(service.search({ title: 'Show' })).rejects.toThrow('Settings');
    });
});
