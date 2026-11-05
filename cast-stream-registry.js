const MAX_CANDIDATES_PER_TAB = 16;
const CANDIDATE_TTL_MS = 15 * 60 * 1000;

function headerValue(headers, name) {
    if (!headers || typeof headers !== 'object') return '';
    const target = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== target) continue;
        return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
    return '';
}

function streamInfo(url, contentType = '') {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const pathname = parsed.pathname.toLowerCase();
    const mime = String(contentType).split(';', 1)[0].trim().toLowerCase();
    if (/\.m3u8$/i.test(pathname) || /application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl/i.test(mime)) {
        return { kind: 'hls', mimeType: 'application/vnd.apple.mpegurl' };
    }
    if (/\.mpd$/i.test(pathname) || mime === 'application/dash+xml') {
        return { kind: 'dash', mimeType: 'application/dash+xml' };
    }
    if (/\.(mp4|m4v)$/i.test(pathname) || /^video\/(mp4|x-m4v)/i.test(mime)) {
        return { kind: 'file', mimeType: 'video/mp4' };
    }
    if (/\.webm$/i.test(pathname) || /^video\/webm/i.test(mime)) {
        return { kind: 'file', mimeType: 'video/webm' };
    }
    if (/\.mov$/i.test(pathname) || /^video\/quicktime/i.test(mime)) {
        return { kind: 'file', mimeType: 'video/quicktime' };
    }
    if (/\.mkv$/i.test(pathname) || /^video\/(x-)?matroska/i.test(mime)) {
        return { kind: 'file', mimeType: 'video/x-matroska' };
    }
    return null;
}

function requestContext(requestHeaders) {
    const result = {};
    // Credentials are intentionally never retained here. The relay uses the
    // originating Electron Session, so its cookie jar remains inside the app.
    for (const [target, source] of [['referer', 'referer'], ['origin', 'origin'], ['user-agent', 'user-agent']]) {
        const value = headerValue(requestHeaders, source);
        if (value) result[target] = value;
    }
    return result;
}

class CastStreamRegistry {
    constructor({ now = () => Date.now(), ttlMs = CANDIDATE_TTL_MS, maxCandidates = MAX_CANDIDATES_PER_TAB } = {}) {
        this.now = now;
        this.ttlMs = ttlMs;
        this.maxCandidates = maxCandidates;
        this.requests = new Map();
        this.candidates = new Map();
    }

    observeRequest(details) {
        const id = String(details?.id || '');
        const webContentsId = Number(details?.webContentsId);
        if (!id || !Number.isInteger(webContentsId) || webContentsId <= 0) return;
        this.requests.set(id, {
            webContentsId,
            url: String(details?.url || ''),
            requestHeaders: requestContext(details?.requestHeaders),
            createdAt: this.now()
        });
        this.pruneRequests();
    }

    observeResponse(details, targetSession) {
        const webContentsId = Number(details?.webContentsId);
        if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
        const id = String(details?.id || '');
        const request = this.requests.get(id);
        if (id) this.requests.delete(id);
        const url = String(details?.url || request?.url || '');
        const info = streamInfo(url, headerValue(details?.responseHeaders, 'content-type'));
        if (!info) return;

        const candidate = {
            ...info,
            url,
            session: targetSession,
            requestHeaders: request?.requestHeaders || {},
            observedAt: this.now(),
            resourceType: String(details?.resourceType || '')
        };
        const current = this.candidates.get(webContentsId) || [];
        const withoutDuplicate = current.filter((item) => item.url !== candidate.url);
        withoutDuplicate.unshift(candidate);
        this.candidates.set(webContentsId, withoutDuplicate.slice(0, this.maxCandidates));
        this.pruneCandidates(webContentsId);
    }

    bestForWebContents(webContentsId) {
        const id = Number(webContentsId);
        this.pruneCandidates(id);
        const candidates = this.candidates.get(id) || [];
        const rank = { hls: 3, file: 2, dash: 1 };
        return candidates.slice().sort((a, b) => (rank[b.kind] || 0) - (rank[a.kind] || 0) || b.observedAt - a.observedAt)[0] || null;
    }

    publicInfo(webContentsId) {
        const candidate = this.bestForWebContents(webContentsId);
        if (!candidate) return null;
        return { kind: candidate.kind, mimeType: candidate.mimeType };
    }

    forgetWebContents(webContentsId) {
        const id = Number(webContentsId);
        this.candidates.delete(id);
        for (const [requestId, request] of this.requests) {
            if (request.webContentsId === id) this.requests.delete(requestId);
        }
    }

    pruneRequests() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, request] of this.requests) {
            if (request.createdAt < cutoff) this.requests.delete(id);
        }
    }

    pruneCandidates(webContentsId) {
        const id = Number(webContentsId);
        const cutoff = this.now() - this.ttlMs;
        const fresh = (this.candidates.get(id) || []).filter((candidate) => candidate.observedAt >= cutoff);
        if (fresh.length) this.candidates.set(id, fresh);
        else this.candidates.delete(id);
    }
}

module.exports = {
    CastStreamRegistry,
    CANDIDATE_TTL_MS,
    MAX_CANDIDATES_PER_TAB,
    headerValue,
    requestContext,
    streamInfo
};
