const { CastRelayService, computeCacheKey, countPlaylistSegments, playlistDuration, pngStubOffset, rewriteHlsManifest, transmuxArgs } = require('../../cast-relay-service');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, PassThrough } = require('stream');

function sourceResponse(body, { status = 200, headers = {} } = {}) {
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const bytes = Buffer.from(body);
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => normalizedHeaders[String(name).toLowerCase()] || null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        body: Readable.toWeb(Readable.from([body]))
    };
}

describe('cast relay service', () => {
    test('keeps blank playlist lines from becoming recursive media requests', () => {
        const rewrite = jest.fn(url => url);
        const playlist = '#EXTM3U\n\n#EXTINF:2,\nsegment.ts\n';
        expect(rewriteHlsManifest(playlist, 'https://media.example/master.m3u8', rewrite))
            .toBe('#EXTM3U\n\n#EXTINF:2,\nhttps://media.example/segment.ts\n');
        expect(rewrite).toHaveBeenCalledTimes(1);
    });

    test('rewrites a playlist to temporary local-only resource routes', () => {
        const rewritten = rewriteHlsManifest(
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n#EXTINF:5,\nsegment.ts',
            'https://media.example/path/master.m3u8',
            (url) => `http://192.168.1.2/relay?source=${encodeURIComponent(url)}`
        );
        expect(rewritten).toContain('source=https%3A%2F%2Fmedia.example%2Fpath%2Fchild.m3u8');
        expect(rewritten).toContain('source=https%3A%2F%2Fmedia.example%2Fpath%2Fsegment.ts');
    });

    test('does not relay encrypted HLS streams', () => {
        expect(() => rewriteHlsManifest(
            '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"',
            'https://media.example/master.m3u8',
            (url) => url
        )).toThrow('encrypted or DRM-protected');
    });

    test('detects PNG-stub disguised segments and leaves real media untouched', () => {
        const pngStub = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(100, 0x12),
            Buffer.from('IEND'),
            Buffer.from([0xae, 0x42, 0x60, 0x82]),
            Buffer.alloc(64, 0x47)
        ]);
        expect(pngStubOffset(pngStub)).toBe(116);
        expect(pngStubOffset(pngStub.subarray(116))).toBe(0);
        expect(pngStubOffset(Buffer.alloc(64, 0x47))).toBe(0);
        // PNG magic without an IEND inside the window is a real image.
        expect(pngStubOffset(Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(5000, 0x7f)
        ]))).toBe(0);
        expect(pngStubOffset(Buffer.alloc(0))).toBe(0);
    });

    test('counts VOD playlist segments for preparation progress', () => {
        const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\na.ts\n#EXTINF:4.5,\nb.ts\n#EXT-X-ENDLIST\n';
        expect(countPlaylistSegments(media)).toBe(2);
        // A master playlist has no media segments of its own.
        expect(countPlaylistSegments('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\n')).toBe(0);
        expect(countPlaylistSegments('')).toBe(0);
    });

    test('cache keys are stable for identical inputs and differ otherwise', () => {
        expect(computeCacheKey('abc', 100, 3600)).toBe(computeCacheKey('abc', 100, 3600));
        expect(computeCacheKey('abc', 100, 3600)).not.toBe(computeCacheKey('abd', 100, 3600));
        expect(computeCacheKey('abc', 101, 3600)).not.toBe(computeCacheKey('abc', 100, 3600));
        expect(computeCacheKey('abc', 100, 3601)).not.toBe(computeCacheKey('abc', 100, 3600));
    });

    test('promotes a finished capture into the cache and serves it again', () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-cache-test-'));
        const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-capture-test-'));
        try {
            const service = new CastRelayService({ address: '127.0.0.1' });
            service.configureCache(cacheDir);
            const filePath = path.join(captureDir, 'stream.mp4');
            fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 7));
            const route = { cacheKey: computeCacheKey('base', 2, 8), cacheHit: false };
            const capture = { dir: captureDir, filePath, ended: true, error: '', exitCode: 0 };
            expect(service.promoteCaptureToCache(route, capture)).toBe(true);
            const entry = service.lookupCacheEntry(route.cacheKey);
            expect(entry.file).toBe(path.join(cacheDir, `${route.cacheKey}.mp4`));
            expect(entry.size).toBe(2 * 1024 * 1024);
            // The temp capture dir can be removed like stop() does; the cache
            // copy survives, also in a fresh service instance.
            fs.rmSync(captureDir, { recursive: true, force: true });
            const reloaded = new CastRelayService({ address: '127.0.0.1' });
            reloaded.configureCache(cacheDir);
            expect(reloaded.lookupCacheEntry(route.cacheKey).size).toBe(2 * 1024 * 1024);
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test('remuxes an HLS playlist to a seekable MP4 for the TV', () => {        expect(transmuxArgs('http://127.0.0.1:45678/cast/token/playlist.m3u8')).toEqual(expect.arrayContaining([
            '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', 'pipe:1'
        ]));
        expect(transmuxArgs('http://127.0.0.1:45678/cast/token/playlist.m3u8', '/tmp/capture.mp4', 'mp4')).toEqual(expect.arrayContaining([
            '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', '/tmp/capture.mp4'
        ]));
    });

    test('totals EXTINF durations and ignores missing ones', () => {
        expect(playlistDuration('#EXTM3U\n#EXTINF:4.5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST')).toBe(9.5);
        expect(playlistDuration('#EXTM3U\n#EXT-X-ENDLIST')).toBeNull();
    });

    test('serves a direct video through its temporary local endpoint', async () => {
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn((callback) => callback())
        };
        const sourceSession = {
            fetch: jest.fn().mockResolvedValue(sourceResponse('video bytes', {
                status: 200,
                headers: { 'content-type': 'video/mp4', 'content-length': '11' }
            }))
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg' });
        try {
            const relay = await service.start({
                kind: 'file',
                mimeType: 'video/mp4',
                url: 'https://media.example/video.mp4?signature=private',
                session: sourceSession,
                requestHeaders: { referer: 'https://player.example/watch' }
            });
            const response = new PassThrough();
            response.writeHead = jest.fn();
            const body = new Promise((resolve, reject) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                response.on('error', reject);
            });
            await service.handleRequest({ method: 'GET', url: new URL(relay.url).pathname, headers: {} }, response);
            await expect(body).resolves.toBe('video bytes');
            expect(sourceSession.fetch).toHaveBeenCalledWith(
                'https://media.example/video.mp4?signature=private',
                expect.objectContaining({ headers: { referer: 'https://player.example/watch' } })
            );
        } finally {
            await service.stop();
        }
    });

    test('serves generated subtitles under the same token as the relayed video', async () => {
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn((callback) => callback())
        };
        const sourceSession = {
            fetch: jest.fn().mockResolvedValue(sourceResponse('video bytes', {
                status: 200,
                headers: { 'content-type': 'video/mp4', 'content-length': '11' }
            }))
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg' });
        try {
            const relay = await service.start({
                kind: 'file',
                mimeType: 'video/mp4',
                url: 'https://media.example/video.mp4',
                session: sourceSession
            });
            const subtitleUrl = await service.serveSubtitle('1\n00:00:00,000 --> 00:00:01,000\nHi\n');
            expect(new URL(subtitleUrl).pathname).toBe(`${new URL(relay.url).pathname.split('/').slice(0, -1).join('/')}/subtitle.srt`);

            const response = new PassThrough();
            response.writeHead = jest.fn();
            const body = new Promise((resolve, reject) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                response.on('error', reject);
            });
            await service.handleRequest({ method: 'GET', url: new URL(subtitleUrl).pathname, headers: {} }, response);
            await expect(body).resolves.toContain('00:00:00,000 --> 00:00:01,000');
            await expect(response.writeHead.mock.calls[0][0]).toBe(200);
        } finally {
            await service.stop();
        }
    });

    test('keeps a standalone subtitle route when no video is relayed', async () => {
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn((callback) => callback())
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg' });
        try {
            const subtitleUrl = await service.serveSubtitle('subs');
            expect(subtitleUrl).toBe('http://127.0.0.1:45678/cast/' + new URL(subtitleUrl).pathname.split('/')[2] + '/subtitle.srt');
            const response = new PassThrough();
            response.writeHead = jest.fn();
            await service.handleRequest({ method: 'HEAD', url: new URL(subtitleUrl).pathname, headers: {} }, response);
            expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/x-subrip; charset=utf-8' }));
        } finally {
            await service.stop();
        }
    });

    test('rejects empty subtitle payloads', async () => {
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(), ffmpegPath: 'ffmpeg' });
        await expect(service.serveSubtitle('')).rejects.toThrow('No subtitle content');
    });

    test('resolves stop even when a client keeps its media connection open', async () => {
        // server.close() never fires its callback while the TV streams; the
        // bailout must still resolve so later casts and IPC replies unblock.
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn()
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg' });
        await service.ensureServer();
        await expect(service.stop()).resolves.toBeUndefined();
    });

    test('serves the growing capture file with byte ranges for TV seeking', async () => {
        const fs = require('fs');
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn((callback) => callback())
        };
        const timers = [];
        const spawnProcess = jest.fn((_command, args) => {
            const fake = new (require('node:events').EventEmitter)();
            fake.stderr = new (require('node:events').EventEmitter)();
            fake.kill = () => {};
            const outputPath = args[args.length - 1];
            let written = 0;
            const timer = setInterval(() => {
                try {
                    fs.appendFileSync(outputPath, Buffer.alloc(1024, 7));
                } catch {
                    // The capture directory can vanish on stop; end the fake.
                    written = 8192;
                }
                written += 1024;
                if (written >= 8192) {
                    clearInterval(timer);
                    fake.emit('close', 0);
                }
            }, 10);
            timers.push(timer);
            return fake;
        });
        const sourceSession = {
            fetch: jest.fn().mockResolvedValue(sourceResponse('#EXTM3U\n#EXTINF:2.5,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST', {
                headers: { 'content-type': 'application/vnd.apple.mpegurl' }
            }))
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg', spawnProcess });
        const heartbeat = setInterval(() => {}, 500);
        try {
            const relay = await service.start({ kind: 'hls', url: 'https://media.example/master.m3u8', session: sourceSession });
            const path = new URL(relay.url).pathname;

            const read = async (requestUrl, headers = {}) => {
                const response = new PassThrough();
                response.writeHead = jest.fn();
                const body = new Promise((resolve, reject) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => resolve(Buffer.concat(chunks)));
                    response.on('error', reject);
                });
                await service.handleRequest({ method: 'GET', url: requestUrl, headers }, response);
                return { response, body: await body };
            };

            const full = await read(path);
            expect(full.response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'accept-ranges': 'bytes',
                'x-content-duration': '6.5'
            }));
            expect(full.body).toHaveLength(8192);

            const ranged = await read(path, { range: 'bytes=2048-4095' });
            expect(ranged.response.writeHead).toHaveBeenCalledWith(206, expect.objectContaining({
                'content-range': 'bytes 2048-4095/8192',
                'x-content-duration': '6.5'
            }));
            expect(ranged.body).toHaveLength(2048);
        } finally {
            clearInterval(heartbeat);
            for (const timer of timers) clearInterval(timer);
            await service.stop();
        }
    });

    test('advertises a finished capture as a finite file on the HEAD probe', async () => {
        const fs = require('fs');
        const server = {
            on: jest.fn(),
            once: jest.fn(),
            off: jest.fn(),
            listen: jest.fn((_port, _host, callback) => callback()),
            address: jest.fn(() => ({ port: 45678 })),
            close: jest.fn((callback) => callback())
        };
        const spawnProcess = jest.fn((_command, args) => {
            const fake = new (require('node:events').EventEmitter)();
            fake.stderr = new (require('node:events').EventEmitter)();
            fake.kill = () => {};
            const outputPath = args[args.length - 1];
            fs.writeFileSync(outputPath, Buffer.alloc(4096, 7));
            // A finished capture: flip route.capture.ended on the next tick.
            setTimeout(() => fake.emit('close', 0), 0);
            return fake;
        });
        const sourceSession = {
            fetch: jest.fn().mockResolvedValue(sourceResponse('#EXTM3U\n#EXTINF:2.5,\na.ts\n#EXT-X-ENDLIST', {
                headers: { 'content-type': 'application/vnd.apple.mpegurl' }
            }))
        };
        const service = new CastRelayService({ address: '127.0.0.1', createServer: jest.fn(() => server), ffmpegPath: 'ffmpeg', spawnProcess });
        try {
            const relay = await service.start({ kind: 'hls', url: 'https://media.example/master.m3u8', session: sourceSession });
            service.prewarmCapture();
            const deadline = Date.now() + 2000;
            while (!service.captureStatus().ended && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(service.captureStatus().ended).toBe(true);

            const response = new PassThrough();
            response.writeHead = jest.fn();
            await service.handleRequest({ method: 'HEAD', url: new URL(relay.url).pathname, headers: {} }, response);
            // A finite length on the HEAD probe is what lets a renderer classify
            // the item as VOD and enable pause/seek instead of streaming it live.
            expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'accept-ranges': 'bytes',
                'content-length': '4096',
                // A finite capture must be advertised as Interactive (seekable VOD),
                // never Streaming (live), or the renderer refuses pause/seek (701).
                'transferMode.dlna.org': 'Interactive'
            }));

            // ffmpeg-based renderers probe the size with an INT64_MAX range; the
            // 416 must come back immediately or their open timeout declares the
            // media unsupported.
            const probeStart = Date.now();
            const probe = new PassThrough();
            probe.writeHead = jest.fn();
            await service.handleRequest({ method: 'GET', url: new URL(relay.url).pathname, headers: { range: 'bytes=9223372036854775807-' } }, probe);
            expect(probe.writeHead).toHaveBeenCalledWith(416, { 'content-range': 'bytes */4096' });
            expect(Date.now() - probeStart).toBeLessThan(1000);
        } finally {
            await service.stop();
        }
    });
});
