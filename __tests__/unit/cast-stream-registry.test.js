const { CastStreamRegistry, streamInfo } = require('../../cast-stream-registry');

describe('cast stream registry', () => {
    test('recognises HLS and common direct video sources', () => {
        expect(streamInfo('https://media.example/movie.m3u8?token=secret')).toMatchObject({ kind: 'hls' });
        expect(streamInfo('https://cdn.example/stream', 'video/mp4; charset=binary')).toEqual({ kind: 'file', mimeType: 'video/mp4' });
        expect(streamInfo('blob:https://player.example/123')).toBeNull();
    });

    test('keeps a bounded, private candidate for each browser tab', () => {
        let now = 1000;
        const registry = new CastStreamRegistry({ now: () => now, maxCandidates: 2, ttlMs: 100 });
        const sourceSession = { fetch: jest.fn() };

        registry.observeRequest({
            id: 'request-1',
            webContentsId: 51,
            url: 'https://media.example/master.m3u8?signature=private',
            requestHeaders: {
                Referer: 'https://player.example/watch',
                Cookie: 'session=private',
                Authorization: 'Bearer private'
            }
        });
        registry.observeResponse({
            id: 'request-1',
            webContentsId: 51,
            url: 'https://media.example/master.m3u8?signature=private',
            responseHeaders: { 'content-type': ['application/vnd.apple.mpegurl'] }
        }, sourceSession);

        expect(registry.publicInfo(51)).toEqual({ kind: 'hls', mimeType: 'application/vnd.apple.mpegurl' });
        const candidate = registry.bestForWebContents(51);
        expect(candidate).toMatchObject({ url: 'https://media.example/master.m3u8?signature=private', session: sourceSession });
        expect(candidate.requestHeaders).toEqual({ referer: 'https://player.example/watch' });

        now += 101;
        expect(registry.bestForWebContents(51)).toBeNull();
    });

    test('ignores session-owned relay requests that do not belong to a tab', () => {
        const registry = new CastStreamRegistry();
        registry.observeRequest({ id: 'relay-1', webContentsId: 0, url: 'https://media.example/video.mp4' });
        expect(registry.requests.size).toBe(0);
    });
});
