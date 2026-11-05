const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// TEMPORARY DIAGNOSTIC — remove once TV transport controls are verified.
const CAST_DEBUG_LOG = '/tmp/cast-relay-debug.log';
function castDebug(message) {
    try {
        fs.appendFileSync(CAST_DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never break casting.
    }
}

function resolveFfmpeg() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    // LaunchServices does not inherit the interactive shell's Homebrew PATH.
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'ffmpeg';
}

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

function localLanAddress() {
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
                return entry.address;
            }
        }
    }
    return '';
}

function responseHeader(response, name) {
    return String(response?.headers?.get?.(name) || '');
}

function isHls(url, contentType = '') {
    try {
        if (/\.m3u8$/i.test(new URL(url).pathname)) return true;
    } catch {
        return false;
    }
    return /application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(contentType);
}

function isSafeRange(value) {
    return typeof value === 'string' && value.length <= 128 && /^bytes=\d*-\d*$/.test(value);
}

function publicResponseHeaders(response) {
    const headers = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        const value = responseHeader(response, name);
        if (value) headers[name] = value;
    }
    return headers;
}

// Some sites disguise HLS segments as tiny PNG images to defeat direct
// downloads; the real media starts right after the stub's IEND chunk. Returns
// the byte offset where the actual payload begins (0 = no stub). A real PNG
// image (IEND not within the inspected window) is left untouched.
function pngStubOffset(head) {
    if (!head || head.length < 16) return 0;
    if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 0;
    const iend = head.indexOf('IEND');
    if (iend === -1 || iend + 8 > head.length) return 0;
    return iend + 8;
}

// Seconds to wait for the remuxer to reach a seek target before answering 416.
const STALL_WAIT_MS = 30000;
// Seconds to wait for the first captured bytes before declaring the stream dead.
const FIRST_BYTES_WAIT_MS = 20000;
// Seconds to wait for appended data mid-stream before closing the response.
const STREAM_STALL_MS = 30000;
// A full VOD playlist can reference thousands of segments; every id in the
// last served playlist must stay resolvable or the TV 404s mid-playback.
const MAX_RESOURCES_PER_ROUTE = 8192;

function transmuxArgs(inputUrl, outputPath = null, container = 'mp4', subtitleFile = '') {
    const isMp4 = container === 'mp4';
    return [
        '-hide_banner',
        '-loglevel', 'error',
        // These URLs point to our tokenized relay, which permits only resources
        // declared in the playlist. Their opaque names do not identify codecs.
        '-allowed_extensions', 'ALL',
        '-allowed_segment_extensions', 'ALL',
        '-extension_picky', '0',
        '-i', inputUrl,
        // An external subtitle is muxed in as a mov_text track: ffmpeg-based
        // renderers (AirScreen) render embedded text tracks natively, unlike
        // DLNA sidecar captions which many of them ignore.
        ...(subtitleFile ? ['-i', subtitleFile, '-map', '1:0', '-c:s', 'mov_text'] : []),
        '-map', '0:v:0?',
        '-map', '0:a:0?',
        // Video is copied untouched; audio is transcoded to AAC stereo because a
        // transport stream tolerates AC3/E-AC3 passthrough but an MP4 must carry
        // AAC to play sound on every TV. faststart moves the seek table to the
        // front so the file is seekable/pausable from the first byte.
        '-c:v', 'copy',
        ...(isMp4 ? ['-c:a', 'aac', '-ac', '2', '-b:a', '256k'] : ['-c:a', 'copy']),
        ...(isMp4 ? ['-movflags', '+faststart'] : ['-mpegts_flags', '+resend_headers']),
        '-f', isMp4 ? 'mp4' : 'mpegts',
        outputPath || 'pipe:1'
    ];
}

// Sums #EXTINF durations; callers decide whether the playlist is VOD.
function playlistDuration(manifest) {
    let total = 0;
    let counted = false;
    for (const line of String(manifest || '').split(/\r?\n/)) {
        const match = /^#EXTINF:(\d+(?:\.\d+)?)\s*(?:,|$)/i.exec(line.trim());
        if (!match) continue;
        const value = Number(match[1]);
        if (Number.isFinite(value)) {
            total += value;
            counted = true;
        }
    }
    return counted ? total : null;
}

// Counts the media segments a VOD playlist will stream, so the preparation
// wait can report real progress (N of M segments fetched).
function countPlaylistSegments(manifest) {
    const matches = String(manifest || '').match(/^#EXTINF/gim);
    return matches ? matches.length : 0;
}

// Stable identity for a captured video: the page/stream identity supplied by
// the caller (query strings stripped, since signed URLs rotate) plus the
// playlist shape (segment count, total duration).
function computeCacheKey(cacheKeyBase, totalSegments, sourceDuration) {
    return crypto.createHash('sha1').update(`${cacheKeyBase}|${totalSegments}|${sourceDuration}`).digest('hex');
}

async function readPlaylist(response) {
    const contentLength = Number(responseHeader(response, 'content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PLAYLIST_BYTES) {
        throw new Error('The streaming playlist is too large to relay.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PLAYLIST_BYTES) throw new Error('The streaming playlist is too large to relay.');
    return buffer.toString('utf8');
}

function absoluteUrl(value, baseUrl) {
    try {
        const resolved = new URL(value, baseUrl);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';
        return resolved.toString();
    } catch {
        return '';
    }
}

function rewriteHlsManifest(manifest, baseUrl, toRelayUrl) {
    const lines = String(manifest || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    return lines.map((line) => {
        if (!line.trim()) return line;
        if (/^#EXT-X-KEY:/i.test(line) && !/METHOD=NONE(?:,|$)/i.test(line)) {
            throw new Error('This HLS stream is encrypted or DRM-protected and cannot be relayed.');
        }
        if (line.startsWith('#')) {
            return line.replace(/URI=(?:"([^"]+)"|([^,\s]+))/gi, (_match, quoted, bare) => {
                const relayUrl = toRelayUrl(absoluteUrl(quoted || bare, baseUrl));
                return relayUrl ? `URI="${relayUrl}"` : _match;
            });
        }
        const target = absoluteUrl(line.trim(), baseUrl);
        return target ? toRelayUrl(target) : line;
    }).join('\n');
}

class CastRelayService {
    constructor({ address = localLanAddress(), createServer = http.createServer, spawnProcess = spawn, ffmpegPath = resolveFfmpeg() } = {}) {
        this.address = address;
        this.createServer = createServer;
        this.spawnProcess = spawnProcess;
        this.ffmpegPath = ffmpegPath;
        this.server = null;
        this.port = null;
        this.routes = new Map();
        this.activeRoute = null;
        // Finished captures can be kept on disk so re-casting the same video
        // skips the whole download+remux. Disabled until a directory is set.
        this.cacheDir = null;
        this.cacheBudgetBytes = 8 * 1024 * 1024 * 1024;
        this.cacheIndex = new Map();
    }

    // Enables the capture cache under dir (called by main with the app's
    // userData path, so the cache survives app restarts).
    configureCache(dir, budgetBytes = 8 * 1024 * 1024 * 1024) {
        if (!dir) return;
        this.cacheDir = dir;
        this.cacheBudgetBytes = budgetBytes;
        try {
            fs.mkdirSync(dir, { recursive: true });
            const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
            const parsed = JSON.parse(raw);
            for (const [key, entry] of Object.entries(parsed || {})) {
                if (key && entry?.file && Number.isFinite(entry.size)) this.cacheIndex.set(key, entry);
            }
        } catch {
            // Missing or unreadable index just means an empty cache.
        }
    }

    lookupCacheEntry(key) {
        if (!key || !this.cacheDir) return null;
        const entry = this.cacheIndex.get(key);
        if (!entry) return null;
        let size = 0;
        try {
            size = fs.statSync(entry.file).size;
        } catch {
            this.cacheIndex.delete(key);
            this.saveCacheIndex();
            return null;
        }
        if (size !== entry.size) {
            // Partial or corrupted leftover — do not serve it.
            this.cacheIndex.delete(key);
            try { fs.rmSync(entry.file, { force: true }); } catch { /* ignore */ }
            this.saveCacheIndex();
            return null;
        }
        return { file: entry.file, size };
    }

    // Moves a cleanly finished capture into the cache and evicts the oldest
    // entries until the total cache size fits the budget.
    promoteCaptureToCache(route, capture) {
        if (!this.cacheDir || !route.cacheKey || route.cacheHit) return false;
        const size = this.captureSize(capture);
        if (size < 1024 * 1024) return false;
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            const target = path.join(this.cacheDir, `${route.cacheKey}.mp4`);
            try {
                fs.renameSync(capture.filePath, target);
            } catch {
                // Cross-device rename can fail; copy + delete instead.
                fs.copyFileSync(capture.filePath, target);
            }
            this.cacheIndex.set(route.cacheKey, {
                file: target,
                size,
                createdAt: Date.now(),
                lastUsedAt: Date.now()
            });
            this.evictCache();
            this.saveCacheIndex();
            castDebug(`cache store: ${size} bytes under key ${route.cacheKey.slice(0, 12)}`);
            return true;
        } catch (error) {
            castDebug(`cache store failed: ${String(error?.message || error).slice(0, 120)}`);
            return false;
        }
    }

    evictCache() {
        let total = 0;
        for (const entry of this.cacheIndex.values()) total += entry.size || 0;
        if (total <= this.cacheBudgetBytes) return;
        const entries = [...this.cacheIndex.entries()]
            .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
        for (const [key, entry] of entries) {
            if (total <= this.cacheBudgetBytes) break;
            try { fs.rmSync(entry.file, { force: true }); } catch { /* ignore */ }
            total -= entry.size || 0;
            this.cacheIndex.delete(key);
        }
    }

    saveCacheIndex() {
        if (!this.cacheDir) return;
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            const flat = {};
            for (const [key, entry] of this.cacheIndex) flat[key] = entry;
            fs.writeFileSync(path.join(this.cacheDir, 'index.json'), JSON.stringify(flat));
        } catch {
            // Cache persistence is best-effort.
        }
    }

    // Removes capture directories and subtitle temp files left behind by a
    // previous app run: a crash or force-quit skips the normal stop() cleanup,
    // and a single abandoned capture can occupy ~200MB.
    sweepAbandonedTempFiles() {
        const tmp = os.tmpdir();
        let entries = [];
        try {
            entries = fs.readdirSync(tmp);
        } catch {
            return;
        }
        for (const name of entries) {
            if (!/^cast-capture-/.test(name) && !/^cast-sub-.+\.srt$/.test(name)) continue;
            try {
                fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
            } catch {
                // Best effort; leftovers are not worth failing startup over.
            }
        }
    }

    async start(source, options = {}) {
        if (!source?.session || typeof source.session.fetch !== 'function') {
            throw new Error('The original browser session is no longer available for this video.');
        }
        if (!source?.url || !['hls', 'file'].includes(source.kind)) {
            if (source?.kind === 'dash') {
                throw new Error('This player uses MPEG-DASH, which this TV relay does not support yet.');
            }
            throw new Error('No compatible video stream is available to relay.');
        }
        if (!this.address) {
            throw new Error('No local network address is available for the TV to reach this browser.');
        }

        await this.stop();
        await this.ensureServer();

        const token = crypto.randomBytes(32).toString('base64url');
        const route = {
            token,
            source,
            resources: new Map(),
            servedResourceIds: new Set(),
            transmuxProcesses: new Set(),
            createdAt: Date.now()
        };
        this.routes.set(token, route);
        this.activeRoute = route;
        const isHlsSource = source.kind === 'hls';

        try {
            // Check access and DRM status before telling the TV to begin playback.
            if (isHlsSource) {
                const playlist = await this.fetchPlaylistWithTimeout(route, source.url);
                // A VOD playlist has a fixed total duration, which Samsung
                // players use to show a seek bar.
                const duration = playlistDuration(playlist);
                if (duration && playlist.includes('#EXT-X-ENDLIST')) route.sourceDuration = duration;
                route.totalSegments = countPlaylistSegments(playlist);
                // A previously captured copy of the same video can be served
                // without downloading or remuxing anything.
                if (this.cacheDir && options.cacheKeyBase) {
                    route.cacheKey = computeCacheKey(options.cacheKeyBase, route.totalSegments, route.sourceDuration || 0);
                    const cached = this.lookupCacheEntry(route.cacheKey);
                    if (cached) {
                        route.cacheHit = true;
                        route.capture = { dir: null, filePath: cached.file, ended: true, error: '', container: 'mp4' };
                        castDebug(`cache hit: serving ${cached.size} bytes for key ${route.cacheKey.slice(0, 12)}`);
                        return this.describeRoute(route, token, isHlsSource, source, true);
                    }
                }
            }
        } catch (error) {
            this.routes.delete(token);
            if (this.activeRoute === route) this.activeRoute = null;
            throw error;
        }
        this.activeRoute = route;
        // HLS is remuxed to a seekable MP4: a transport stream plays but has no
        // seek table, so the TV refuses pause/seek (UPnP 701); an MP4 with a
        // faststart moov is finite and byte-range seekable. ffmpeg only remuxes
        // (video copy) and re-muxes audio to AAC; it does not decrypt the source.
        return this.describeRoute(route, token, isHlsSource, source, false);
    }

    describeRoute(route, token, isHlsSource, source, cached) {
        const container = isHlsSource ? 'mp4' : 'file';
        route.container = container;
        const extension = isHlsSource ? 'stream.mp4' : 'video';
        return {
            url: `http://${this.address}:${this.port}/cast/${token}/${extension}`,
            mimeType: isHlsSource ? 'video/mp4' : (source.mimeType || 'video/mp4'),
            protocolInfo: isHlsSource
                ? 'http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=ED100000000000000000000000000000'
                : undefined,
            // The DIDL res element carries this so renderers that gate REL_TIME
            // seek on a declared duration allow trick modes.
            duration: isHlsSource ? (route.sourceDuration || null) : null,
            cached: !!cached
        };
    }

    stop() {
        for (const route of this.routes.values()) {
            for (const process of route.transmuxProcesses) {
                try {
                    process.kill('SIGTERM');
                } catch {
                    // The process may already have exited.
                }
                // A wedged remuxer can ignore SIGTERM; make sure it dies.
                const forceKill = setTimeout(() => {
                    try {
                        process.kill('SIGKILL');
                    } catch {
                        // Already gone.
                    }
                }, 1500);
                forceKill.unref?.();
            }
            // A cleanly finished capture of a cacheable video is promoted to
            // the persistent cache; everything else is discarded.
            if (route.capture && this.promoteCaptureToCache(route, route.capture)) {
                // The capture file was moved out; only the temp dir remains.
            }
            if (route.capture?.dir) {
                try {
                    fs.rmSync(route.capture.dir, { recursive: true, force: true });
                } catch {
                    // Best effort cleanup of the capture temp directory.
                }
            }
            if (route.subtitleFile) {
                try {
                    fs.rmSync(route.subtitleFile, { force: true });
                } catch {
                    // Best effort cleanup of the subtitle temp file.
                }
            }
        }
        this.routes.clear();
        this.activeRoute = null;
        if (!this.server) return Promise.resolve();
        const server = this.server;
        this.server = null;
        this.port = null;
        return new Promise((resolve) => {
            // DLNA TVs hold the media connection open while playing, and
            // server.close() waits for those connections to end. Force them
            // closed and keep a bailout so a stuck socket can never hang a
            // later cast or an IPC reply.
            const finish = () => resolve();
            server.close(finish);
            server.closeAllConnections?.();
            const bailout = setTimeout(finish, 250);
            bailout.unref?.();
        });
    }

    // Serves generated subtitle content (SRT bytes) under the same tokenized
    // host as the video. Samsung renderers only honor captions served from the
    // same host:port as the media, so an active relay route is preferred; a
    // standalone route keeps direct-URL casts working too.
    async serveSubtitle(content) {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
        if (!buffer.length) throw new Error('No subtitle content is available for this video.');
        await this.ensureServer();
        if (this.activeRoute) {
            this.activeRoute.subtitle = buffer;
            return `http://${this.address}:${this.port}/cast/${this.activeRoute.token}/subtitle.srt`;
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const route = {
            token,
            source: null,
            resources: new Map(),
            transmuxProcesses: new Set(),
            createdAt: Date.now(),
            subtitle: buffer
        };
        this.routes.set(token, route);
        return `http://${this.address}:${this.port}/cast/${token}/subtitle.srt`;
    }

    // Reports whether the active route's capture has finished, so callers can
    // delay Play until the TV can fetch a finite, seekable file. error carries
    // the remuxer's stderr tail when the capture died.
    captureStatus() {
        const route = this.activeRoute;
        if (!route?.capture) return { ended: false, size: 0, error: '', hasCapture: false };
        return {
            ended: !!route.capture.ended,
            size: this.captureSize(route.capture),
            error: route.capture.error || '',
            hasCapture: true
        };
    }

    hasActiveRoute() {
        return !!this.activeRoute;
    }

    // Preparation progress for the panel while the VOD is being captured:
    // percent is exact when the playlist declared its segments, otherwise only
    // the captured size is known.
    castProgress() {
        const route = this.activeRoute;
        if (!route) return null;
        const status = this.captureStatus();
        const served = route.servedResourceIds?.size || 0;
        const percent = route.totalSegments > 0
            ? Math.min(100, Math.round((served / route.totalSegments) * 100))
            : null;
        return {
            percent,
            capturedMb: Math.round(status.size / (1024 * 1024)),
            ended: status.ended
        };
    }

    // Starts the capture without waiting for a TV request; used so the whole
    // VOD is on disk before Play is sent to the renderer. subtitleFile (an .srt
    // on disk) is muxed into the MP4 as a mov_text track when provided.
    prewarmCapture(subtitleFile = '') {
        const route = this.activeRoute;
        if (!route || route.source?.kind !== 'hls') return;
        try {
            this.ensureCapture(route, subtitleFile);
        } catch {
            // Play proceeds with the growing stream if the remuxer fails.
        }
    }

    async ensureServer() {
        if (this.server && this.port) return;
        const server = this.createServer((request, response) => {
            void this.handleRequest(request, response);
        });
        server.on('clientError', (_error, socket) => socket.destroy());
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '0.0.0.0', () => {
                server.off('error', reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Could not start the local TV relay.');
        }
        this.server = server;
        this.port = address.port;
    }

    async handleRequest(request, response) {
        try {
            if (!['GET', 'HEAD'].includes(request.method || '')) {
                response.writeHead(405, { Allow: 'GET, HEAD' });
                response.end();
                return;
            }
            const match = /^\/cast\/([A-Za-z0-9_-]+)\/(playlist\.m3u8|stream\.(?:ts|mp4)|video|subtitle\.srt|resource\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?)$/.exec(request.url || '');
            const route = match ? this.routes.get(match[1]) : null;
            castDebug(`req ${request.method} ${request.url} range=${request.headers?.range || '-'} tsr=${request.headers?.['timeseekerange.dlna.org'] || '-'} ua=${String(request.headers?.['user-agent'] || '').slice(0, 40)}`);
            if (!route) {
                response.writeHead(404);
                response.end();
                return;
            }

            if (match[2] === 'subtitle.srt') {
                if (!route.subtitle) {
                    response.writeHead(404);
                    response.end();
                    return;
                }
                response.writeHead(200, {
                    'content-type': 'application/x-subrip; charset=utf-8',
                    'cache-control': 'no-store'
                });
                if (request.method !== 'HEAD') response.end(route.subtitle);
                else response.end();
                return;
            }
            if (match[2] === 'playlist.m3u8') {
                await this.sendPlaylist(route, route.source.url, request, response);
                return;
            }
            if (match[2] === 'stream.ts' || match[2] === 'stream.mp4') {
                await this.sendTransmux(route, request, response);
                return;
            }
            if (match[2] === 'video') {
                await this.sendResource(route, route.source.url, request, response);
                return;
            }
            const resource = route.resources.get(match[3]);
            if (!resource) {
                response.writeHead(404);
                response.end();
                return;
            }
            if (isHls(resource)) await this.sendPlaylist(route, resource, request, response);
            else await this.sendResource(route, resource, request, response, match[3]);
        } catch (error) {
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(error?.message || 'The browser could not relay this stream.');
        }
    }

    sourceHeaders(route, request) {
        const headers = { ...(route.source.requestHeaders || {}) };
        const range = request?.headers?.range;
        if (isSafeRange(range)) headers.range = range;
        return headers;
    }

    async fetchPlaylistWithTimeout(route, url, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
            return await this.fetchPlaylist(route, url, { headers: {} }, { signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) throw new Error('The video source took too long to respond.');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async fetchSource(route, url, request, extraInit = {}) {
        // Video CDNs frequently reject or stall Chromium's network stack for
        // non-page fetches (net::ERR_FAILED). Node's fetch goes straight to
        // the origin with the observed page headers; the tab's session remains
        // the fallback for cookie-dependent origins.
        const headers = this.sourceHeaders(route, request);
        const init = { method: 'GET', headers, ...extraInit };
        let response;
        try {
            response = await fetch(url, init);
            castDebug(`upstream-node ${response?.status} ${url.slice(0, 200)}`);
        } catch (nodeError) {
            castDebug(`upstream-node FAILED ${url.slice(0, 200)} :: ${nodeError?.message || nodeError} cause=${nodeError?.cause?.message || nodeError?.cause?.code || '-'}`);
            const session = route.source.session;
            const electronModule = require('electron');
            try {
                response = electronModule?.net?.fetch
                    ? await electronModule.net.fetch(url, { ...init, session })
                    : await session.fetch(url, init);
                castDebug(`upstream-electron ${response?.status} ${url.slice(0, 200)}`);
            } catch (error) {
                castDebug(`upstream-electron FAILED ${url.slice(0, 200)} :: ${error?.message || error}`);
                throw nodeError;
            }
        }
        if (!response || (!response.ok && response.status !== 206)) {
            castDebug(`upstream bad status ${response?.status} ${url.slice(0, 200)}`);
            throw new Error(`The video source returned HTTP ${response?.status || 'error'}.`);
        }
        return response;
    }

    relayUrl(route, originalUrl) {
        if (!originalUrl) return '';
        // Stable ids per source URL keep re-fetched playlists (live streams)
        // from churning the map, and keep every id in a served playlist valid.
        let id = route.resourceIdsByUrl?.get(originalUrl);
        if (!id) {
            route.resourceIdsByUrl = route.resourceIdsByUrl || new Map();
            while (route.resources.size >= MAX_RESOURCES_PER_ROUTE) {
                const oldestId = route.resources.keys().next().value;
                const oldestUrl = route.resources.get(oldestId);
                route.resources.delete(oldestId);
                if (oldestUrl) route.resourceIdsByUrl.delete(oldestUrl);
            }
            id = crypto.randomBytes(18).toString('base64url');
            route.resources.set(id, originalUrl);
            route.resourceIdsByUrl.set(originalUrl, id);
        }
        const extension = new URL(originalUrl).pathname.match(/\.(m3u8|ts|m4s|mp4|aac|vtt)$/i)?.[0] || '';
        return `http://${this.address}:${this.port}/cast/${route.token}/resource/${id}${extension}`;
    }

    async playlistFromResponse(route, url, response) {
        const playlist = await readPlaylist(response);
        return rewriteHlsManifest(playlist, url, (resourceUrl) => this.relayUrl(route, resourceUrl));
    }

    async fetchPlaylist(route, url, request, extraInit = {}) {
        return this.playlistFromResponse(route, url, await this.fetchSource(route, url, request, extraInit));
    }

    async sendPlaylist(route, url, request, response) {
        const playlist = await this.fetchPlaylist(route, url, request);
        response.writeHead(200, {
            'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'cache-control': 'no-store'
        });
        if (request.method !== 'HEAD') response.end(playlist);
        else response.end();
    }

    async sendResource(route, url, request, response, resourceId = '') {
        if (resourceId) route.servedResourceIds.add(resourceId);
        const sourceResponse = await this.fetchSource(route, url, request);
        if (isHls(url, responseHeader(sourceResponse, 'content-type'))) {
            const playlist = await this.playlistFromResponse(route, url, sourceResponse);
            response.writeHead(200, {
                'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
                'cache-control': 'no-store'
            });
            if (request.method !== 'HEAD') response.end(playlist);
            else response.end();
            return;
        }
        if (request.method === 'HEAD' || !sourceResponse.body) {
            response.writeHead(sourceResponse.status, publicResponseHeaders(sourceResponse));
            response.end();
            return;
        }
        // Peek the first bytes before writing headers: a disguised segment is
        // detected (and its stub stripped) here, and a stripped body must not
        // keep the upstream content-length.
        const reader = sourceResponse.body.getReader();
        const PEEK_LIMIT = 4096;
        const peeked = [];
        let peekedSize = 0;
        let peekDone = false;
        try {
            while (peekedSize < PEEK_LIMIT) {
                const { done, value } = await reader.read();
                if (done) { peekDone = true; break; }
                peeked.push(Buffer.from(value));
                peekedSize += value.byteLength;
            }
        } catch {
            response.destroy();
            return;
        }
        const head = Buffer.concat(peeked);
        const payloadOffset = pngStubOffset(head);
        const headers = publicResponseHeaders(sourceResponse);
        if (payloadOffset > 0) {
            castDebug(`segment png-stub stripped: ${payloadOffset} bytes from ${url.slice(0, 120)}`);
            if (headers['content-length']) {
                headers['content-length'] = String(Math.max(0, Number(headers['content-length']) - payloadOffset));
            }
        }
        response.writeHead(sourceResponse.status, headers);
        const rest = head.subarray(payloadOffset);
        if (rest.length) response.write(rest);
        if (peekDone) {
            response.end();
            return;
        }
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                response.write(Buffer.from(value));
            }
            response.end();
        } catch {
            response.destroy();
        }
    }

    // Starts one long-lived ffmpeg per route that captures the remuxed
    // transport stream into a temp file. TVs open several connections (probe,
    // resume, seeks) and all read the same growing file with byte ranges, so
    // pause/resume stays position-accurate and the remote controls stay live.
    ensureCapture(route, subtitleFile = '') {
        if (route.capture) return route.capture;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-capture-'));
        const container = route.container || 'mp4';
        const filePath = path.join(dir, container === 'mp4' ? 'stream.mp4' : 'stream.ts');
        const inputUrl = `http://127.0.0.1:${this.port}/cast/${route.token}/playlist.m3u8`;
        if (subtitleFile) route.subtitleFile = subtitleFile;
        let process;
        try {
            process = this.spawnProcess(this.ffmpegPath, transmuxArgs(inputUrl, filePath, container, subtitleFile), {
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true
            });
        } catch {
            fs.rmSync(dir, { recursive: true, force: true });
            throw new Error('The local video remuxer could not start. Install ffmpeg, then try again.');
        }
        route.transmuxProcesses.add(process);
        const capture = { dir, filePath, process, ended: false, error: '', container };
        process.stderr?.on?.('data', (chunk) => {
            if (capture.error.length < 512) capture.error += String(chunk).slice(0, 512 - capture.error.length);
        });
        process.once?.('error', () => {
            capture.ended = true;
            capture.error = capture.error || 'The local video remuxer could not start.';
        });
        process.once?.('close', (code) => {
            route.transmuxProcesses.delete(process);
            capture.ended = true;
            capture.exitCode = code;
            castDebug(`capture closed code=${code} size=${this.captureSize(capture)} err=${capture.error.slice(0, 120)}`);
            if (code) capture.error = capture.error || `The video remuxer stopped (exit ${code}).`;
        });
        route.capture = capture;
        castDebug(`capture started dir=${dir}`);
        return capture;
    }

    captureSize(capture) {
        try {
            return fs.statSync(capture.filePath).size;
        } catch {
            return 0;
        }
    }

    waitForSize(capture, target, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve) => {
            const tick = () => {
                const size = this.captureSize(capture);
                if (size >= target || capture.ended || Date.now() > deadline) return resolve(size);
                const timer = setTimeout(tick, 250);
                timer.unref?.();
            };
            tick();
        });
    }

    appendRange(filePath, response, start, end) {
        return new Promise((resolve) => {
            const stream = fs.createReadStream(filePath, { start, end });
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                response.off?.('drain', onDrain);
                resolve(value);
            };
            const onDrain = () => stream.resume();
            response.on('drain', onDrain);
            response.once?.('close', () => stream.destroy());
            stream.on('data', (chunk) => {
                if (!response.write(chunk)) stream.pause();
            });
            stream.on('error', () => finish(false));
            stream.on('end', () => finish(true));
        });
    }

    async pumpCapture(capture, response, start, stopByte) {
        castDebug(`pump start=${start} stop=${stopByte}`);
        let offset = start;
        while (!response.writableEnded && !response.destroyed) {
            const size = this.captureSize(capture);
            if (offset >= size) {
                if (capture.ended) break;
                await this.waitForSize(capture, offset + 1, STREAM_STALL_MS);
                if (this.captureSize(capture) <= offset) break;
                continue;
            }
            const chunkEnd = stopByte === null ? size - 1 : Math.min(stopByte, size - 1);
            if (chunkEnd < offset) break;
            const flowed = await this.appendRange(capture.filePath, response, offset, chunkEnd);
            if (!flowed) break;
            offset = chunkEnd + 1;
            if (stopByte !== null && offset > stopByte) break;
        }
        castDebug(`pump done offset=${offset} destroyed=${response.destroyed}`);
        if (!response.writableEnded && !response.destroyed) response.end();
    }

    async sendTransmux(route, request, response) {
        if (request.method === 'HEAD') {
            const capture = route.capture;
            response.writeHead(200, {
                'content-type': route.container === 'mp4' ? 'video/mp4' : 'video/mpeg',
                'cache-control': 'no-store',
                'accept-ranges': 'bytes',
                // A finished capture is a finite, byte-range seekable file, so it is
                // advertised as Interactive; "Streaming" marks it as a live feed the
                // renderer will refuse to pause or seek (UPnP 701).
                'transferMode.dlna.org': capture?.ended ? 'Interactive' : 'Streaming',
                // Advertising its length (and the byte-range support above) is what
                // lets a renderer classify it as VOD and enable pause/seek.
                ...(capture?.ended ? { 'content-length': String(this.captureSize(capture)) } : {}),
                ...(route.sourceDuration ? { 'x-content-duration': String(route.sourceDuration) } : {})
            });
            response.end();
            return;
        }
        const capture = this.ensureCapture(route);
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers?.range || ''));
        const explicitRange = !!range && (range[1] !== '' || range[2] !== '');
        const start = range && range[1] ? Number(range[1]) : 0;
        const stopByte = range && range[2] ? Number(range[2]) : null;

        if (start > 0 && this.captureSize(capture) <= start) {
            // Out-of-range starts must be refused immediately. ffmpeg-based
            // renderers (AirScreen among them) probe the resource size by
            // requesting bytes=<INT64_MAX>- and expect an instant
            // "416 + Content-Range: bytes */<size>"; stalling here (a wait that
            // only makes sense for a small seek into a growing file) trips
            // their open timeout and the item is reported unsupported.
            const size = this.captureSize(capture);
            response.writeHead(416, { 'content-range': `bytes */${size || '*'}` });
            response.end();
            return;
        } else if (start === 0 && this.captureSize(capture) === 0 && !capture.ended) {
            const size = await this.waitForSize(capture, 1, FIRST_BYTES_WAIT_MS);
            if (size === 0) throw new Error('The video remuxer stopped before playback began.');
        }

        const size = this.captureSize(capture);
        if (size === 0) throw new Error('The video remuxer stopped before playback began.');
        const last = stopByte === null ? null : Math.min(stopByte, size - 1);
        if (last !== null && last < start) {
            response.writeHead(416, { 'content-range': `bytes */${size}` });
            response.end();
            return;
        }
        castDebug(`stream respond status=${explicitRange ? 206 : 200} start=${start} stop=${stopByte} size=${size} ended=${capture.ended} err=${capture.error.slice(0, 60)}`);
        response.writeHead(explicitRange ? 206 : 200, {
            'content-type': route.container === 'mp4' ? 'video/mp4' : 'video/mpeg',
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
            // A finished capture is a finite, byte-range seekable file, so it is
            // advertised as Interactive; "Streaming" marks it as a live feed the
            // renderer will refuse to pause or seek (UPnP 701).
            'transferMode.dlna.org': capture.ended ? 'Interactive' : 'Streaming',
            ...(route.sourceDuration ? { 'x-content-duration': String(route.sourceDuration) } : {}),
            ...(capture.ended ? { 'content-length': String(size) } : {}),
            ...(explicitRange
                ? {
                    'content-range': `bytes ${start}-${last === null ? size - 1 : last}/${capture.ended ? size : '*'}`
                }
                : {})
        });
        await this.pumpCapture(capture, response, start, explicitRange ? last : null);
    }
}

module.exports = {
    CastRelayService,
    absoluteUrl,
    computeCacheKey,
    countPlaylistSegments,
    isHls,
    localLanAddress,
    playlistDuration,
    pngStubOffset,
    rewriteHlsManifest,
    transmuxArgs
};
