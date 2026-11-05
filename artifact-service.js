const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const DynamicArtifactService = require('./dynamic-artifact-service');
const { renderFrame } = require('./dynamic-artifact-frame');

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_STORAGE_BYTES = 1_000_000_000;
const MAX_TEXT_ARTIFACT_CHARS = 2_000_000;
const MAX_TEXT_PREVIEW_CHARS = 1_000_000;

function safeName(value) {
    const name = path.basename(String(value || '').trim()).replace(/[\0/\\]/g, '');
    if (!name || name === '.' || name === '..' || name.length > 180) throw new Error('name must be a safe filename up to 180 characters.');
    return name;
}

function isHtml(name, type) {
    return /^text\/html(?:;|$)/i.test(String(type || '')) || /\.html?$/i.test(name);
}

function inferContentType(name, requestedType) {
    const supplied = String(requestedType || '').trim();
    if (supplied) return supplied.slice(0, 120);
    const extension = path.extname(name).toLowerCase();
    const known = {
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8'
    };
    return known[extension] || 'text/plain; charset=utf-8';
}

function isTextArtifact(name, type) {
    return /^text\//i.test(String(type || ''))
        || /^(?:application\/(?:json|xml)|[^/]+\/[^/]+\+(?:json|xml))(?:;|$)/i.test(String(type || ''))
        || /\.(?:csv|json|md|markdown|txt|xml|ya?ml|log)$/i.test(name);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function staticPreview(artifact, content, downloadUrl) {
    const title = escapeHtml(artifact.name);
    const type = escapeHtml(artifact.contentType);
    const link = escapeHtml(downloadUrl);
    let body;
    if (isTextArtifact(artifact.name, artifact.contentType)) {
        const text = content.toString('utf8');
        const truncated = text.length > MAX_TEXT_PREVIEW_CHARS;
        body = `<pre>${escapeHtml(text.slice(0, MAX_TEXT_PREVIEW_CHARS))}</pre>${truncated ? '<p class="notice">Preview truncated. Download the file for the complete content.</p>' : ''}`;
    } else {
        body = '<p>This file type is not rendered inline. Download it to open it with a compatible application.</p>';
    }
    return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:28px;background:#f8fafc;color:#0f172a;font:14px/1.5 system-ui,sans-serif}main{max-width:960px;margin:auto}h1{font-size:20px;margin:0 0 4px}p{color:#475569}.actions{margin:20px 0}.download{display:inline-block;padding:8px 12px;border-radius:7px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid #dbe3ee;border-radius:10px;background:#fff;color:#111827}.notice{font-weight:600}</style><main><h1>${title}</h1><p>${type} · ${artifact.size.toLocaleString()} bytes</p><p class="actions"><a class="download" href="${link}">Download file</a></p>${body}</main>`;
}

function json(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    response.end(body);
}

function readBody(request, maxBytes = Math.ceil(MAX_ARTIFACT_BYTES * 1.4)) {
    return new Promise((resolve, reject) => {
        let body = ''; let size = 0;
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            size += Buffer.byteLength(chunk);
            if (size > maxBytes) { request.destroy(); reject(new Error('Request body is too large.')); return; }
            body += chunk;
        });
        request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body must be valid JSON.')); } });
        request.on('error', reject);
    });
}

function isArtifactId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

class ArtifactService {
    constructor({ app, requestBrowserTool, logger = console }) {
        this.app = app;
        this.requestBrowserTool = requestBrowserTool;
        this.logger = logger;
        this.server = null; this.port = null; this.token = null;
        this.artifacts = new Map();
        this.dynamic = new DynamicArtifactService({ directory: path.join(app.getPath('userData'), 'dynamic-artifacts'), requestBrowserTool });
    }

    get directory() { return path.join(this.app.getPath('userData'), 'opencode-artifacts'); }
    get manifestPath() { return path.join(this.directory, 'manifest.json'); }

    async saveManifest() {
        const artifacts = [...this.artifacts.values()].map(({ id, name, contentType, size, createdAt }) => ({ id, name, contentType, size, createdAt }));
        const temporaryPath = `${this.manifestPath}.tmp`;
        await fsp.writeFile(temporaryPath, `${JSON.stringify({ version: 1, artifacts }, null, 2)}\n`, { mode: 0o600 });
        await fsp.rename(temporaryPath, this.manifestPath);
    }

    async loadArtifacts() {
        this.artifacts.clear();
        let manifest;
        try {
            manifest = JSON.parse(await fsp.readFile(this.manifestPath, 'utf8'));
        } catch (error) {
            if (error?.code !== 'ENOENT') this.logger.warn(`[Artifacts] Could not read artifact library: ${error?.message || error}`);
            return;
        }

        if (!Array.isArray(manifest?.artifacts)) {
            this.logger.warn('[Artifacts] Artifact library has an invalid manifest.');
            return;
        }

        let discarded = false;
        for (const saved of manifest.artifacts.slice(0, MAX_ARTIFACTS)) {
            try {
                if (!isArtifactId(saved?.id)) throw new Error('Invalid artifact id.');
                const name = safeName(saved.name);
                const filePath = path.join(this.directory, saved.id);
                const file = await fsp.lstat(filePath);
                if (!file.isFile() || file.isSymbolicLink() || !file.size || file.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact file is unavailable.');
                const createdAt = new Date(saved.createdAt);
                if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid artifact timestamp.');
                this.artifacts.set(saved.id, {
                    id: saved.id,
                    publicToken: crypto.randomBytes(24).toString('base64url'),
                    name,
                    contentType: inferContentType(name, saved.contentType),
                    size: file.size,
                    createdAt: createdAt.toISOString(),
                    filePath
                });
            } catch {
                discarded = true;
            }
        }
        if (discarded || this.artifacts.size !== manifest.artifacts.length) await this.saveManifest();
    }

    async start() {
        if (this.starting) return this.starting;
        this.starting = this.startServer();
        try { return await this.starting; } finally { this.starting = null; }
    }

    async startServer() {
        if (this.server) return this.connection();
        this.dynamic.start();
        await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.loadArtifacts();
        this.token = crypto.randomBytes(32).toString('base64url');
        this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
            this.logger.warn(`[Artifacts] Request failed: ${error?.message || error}`);
            if (!res.headersSent) json(res, 400, { ok: false, error: { code: 'artifact_request_failed', message: error.message || String(error) } });
            else res.end();
        }));
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); this.port = this.server.address().port; resolve(); });
        });
        return this.connection();
    }

    connection() {
        if (!this.port || !this.token) throw new Error('Artifact service is not running.');
        return { url: `http://127.0.0.1:${this.port}/tool`, token: this.token };
    }

    authorized(req) {
        const supplied = String(req.headers['x-artifact-token'] || '');
        return !!this.token && supplied.length === this.token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
    }

    url(artifact, mode) { return `http://127.0.0.1:${this.port}/artifact/${artifact.id}/${artifact.publicToken}/${mode}`; }
    describe(artifact) { return { id: artifact.id, name: artifact.name, contentType: artifact.contentType, size: artifact.size, createdAt: artifact.createdAt, html: isHtml(artifact.name, artifact.contentType), viewUrl: this.url(artifact, 'view'), downloadUrl: this.url(artifact, 'download') }; }
    storage() {
        const usedBytes = [...this.artifacts.values()].reduce((total, artifact) => total + artifact.size, 0);
        return { usedBytes, limitBytes: MAX_ARTIFACT_STORAGE_BYTES, atLimit: usedBytes >= MAX_ARTIFACT_STORAGE_BYTES };
    }

    async create(args) {
        if (this.artifacts.size >= MAX_ARTIFACTS) throw new Error(`Maximum of ${MAX_ARTIFACTS} session artifacts reached.`);
        const name = safeName(args.name);
        if (typeof args.content !== 'string' || !args.content) throw new Error('content must be a non-empty UTF-8 text string.');
        if (args.content.length > MAX_TEXT_ARTIFACT_CHARS) throw new Error(`content must contain at most ${MAX_TEXT_ARTIFACT_CHARS.toLocaleString()} characters.`);
        const content = Buffer.from(args.content, 'utf8');
        if (!content.length || content.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact must contain 1-${MAX_ARTIFACT_BYTES} bytes.`);
        const storage = this.storage();
        if (storage.usedBytes + content.length > MAX_ARTIFACT_STORAGE_BYTES) {
            throw new Error('Artifact storage limit of 1 GB has been reached. Delete existing artifacts before creating another file.');
        }
        const artifact = { id: crypto.randomUUID(), publicToken: crypto.randomBytes(24).toString('base64url'), name, contentType: inferContentType(name, args.contentType), size: content.length, createdAt: new Date().toISOString() };
        artifact.filePath = path.join(this.directory, artifact.id);
        await fsp.writeFile(artifact.filePath, content, { mode: 0o600 });
        this.artifacts.set(artifact.id, artifact);
        await this.saveManifest();
        return { ok: true, artifact: this.describe(artifact) };
    }

    get(id) { const artifact = this.artifacts.get(String(id || '')); if (!artifact) throw new Error('Artifact was not found in this session.'); return artifact; }
    async open(id) {
        if (!this.artifacts.has(id)) {
            const artifact = this.dynamic.describe(this.dynamic.get(id));
            const viewUrl = `http://127.0.0.1:${this.port}/artifact/${id}/${this.dynamic.token(id)}/view`;
            const browser = await this.requestBrowserTool({ tool: 'open_tab', args: { url: viewUrl, title: artifact.name, activate: true }, timeoutMs: 30000 });
            return { ok: !!browser?.ok, artifact, browser };
        }
        const artifact = this.get(id); const browser = await this.requestBrowserTool({ tool: 'open_tab', args: { url: this.url(artifact, 'view'), title: artifact.name, activate: true }, timeoutMs: 30000 }); return { ok: !!browser?.ok, artifact: this.describe(artifact), browser };
    }
    async download(id) { const artifact = this.get(id); const browser = await this.requestBrowserTool({ tool: 'open_tab', args: { url: this.url(artifact, 'download'), title: `Download ${artifact.name}`, activate: true }, timeoutMs: 30000 }); return { ok: !!browser?.ok, artifact: this.describe(artifact), browser }; }
    async remove(id) {
        if (!this.artifacts.has(id)) { this.dynamic.remove(id); return { ok: true }; }
        const artifact = this.get(id);
        await fsp.unlink(artifact.filePath);
        this.artifacts.delete(artifact.id);
        await this.saveManifest();
        return { ok: true, artifact: this.describe(artifact) };
    }

    async tool(payload) {
        switch (payload.tool) {
        case 'get_dynamic_artifact_guide': return { ok: true, instructions: require('./dynamic-artifact-prompt'), starterHtml: await fsp.readFile(path.join(__dirname, 'dynamic-artifact-starter.html'), 'utf8') };
        case 'create_dynamic_artifact': return { ok: true, artifact: this.dynamic.save(payload.args || {}) };
        case 'update_dynamic_artifact': return { ok: true, artifact: this.dynamic.save(payload.args || {}, payload.args?.id) };
        case 'get_dynamic_artifact': {
            const row = this.dynamic.get(payload.args?.id);
            return { ok: true, id: row.id, ...row.definition, state: this.dynamic.state(row.id) };
        }
        case 'create_artifact': return this.create(payload.args || {});
        case 'list_artifacts': return { ok: true, artifacts: [...this.artifacts.values()].map((artifact) => this.describe(artifact)).concat(this.dynamic.list()), storage: this.storage() };
        case 'open_artifact': return this.open(payload.args?.id);
        case 'download_artifact': return this.download(payload.args?.id);
        default: return { ok: false, error: { code: 'unknown_artifact_tool', message: 'Unknown artifact tool.' } };
        }
    }

    async handle(req, res) {
        const route = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'POST' && route.pathname === '/tool') {
            if (!this.authorized(req)) { json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Unauthorized artifact request.' } }); return; }
            json(res, 200, await this.tool(await readBody(req))); return;
        }
        const match = route.pathname.match(/^\/artifact\/([0-9a-f-]+)\/([A-Za-z0-9_-]+)\/(view|download|api)$/);
        if (!match) { json(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown artifact.' } }); return; }
        if (!this.artifacts.has(match[1])) {
            const row = this.dynamic.get(match[1]);
            if (match[2] !== this.dynamic.token(row.id)) { json(res, 404, { error: 'Unknown artifact' }); return; }
            if (match[3] === 'view' && req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
                    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'" });
                res.end(renderFrame(row)); return;
            }
            const origin = `http://127.0.0.1:${this.port}`;
            if (match[3] !== 'api' || req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-dynamic-request'] !== '1') { json(res, 403, { error: 'Forbidden' }); return; }
            try {
                const body = await readBody(req, 120000); let value;
                switch (body.method) {
                case 'heartbeat': {
                    this.dynamic.leases.set(row.id, Date.now());
                    if (body.opening && (row.settings.mode === 'open' || (row.settings.mode === 'daily' && Date.now() - row.last_success >= 86400000))) this.dynamic.refresh(row.id).catch(() => {});
                    value = this.dynamic.state(row.id); break;
                }
                case 'state': value = this.dynamic.state(row.id); break;
                case 'refresh': value = await this.dynamic.refresh(row.id); break;
                case 'get': case 'set': value = this.dynamic.storage(row.id, body.method, body.key, body.value); break;
                case 'settings': value = this.dynamic.settings(row.id, body.settings || {}); break;
                case 'open-source': {
                    const source = row.definition.sources.find(s => s.id === body.sourceId);
                    if (!source) throw new Error('Unknown source');
                    value = await this.requestBrowserTool({ tool: 'open_tab', args: { url: source.url, activate: true }, timeoutMs: 20000 }); break;
                }
                default: throw new Error('Unknown app operation');
                }
                json(res, 200, { value });
            } catch (error) { json(res, 400, { error: error.message }); }
            return;
        }
        const artifact = this.get(match[1]);
        if (match[2].length !== artifact.publicToken.length || !crypto.timingSafeEqual(Buffer.from(match[2]), Buffer.from(artifact.publicToken))) { json(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown artifact.' } }); return; }
        const content = await fsp.readFile(artifact.filePath);
        if (match[3] === 'view') {
            const interactiveHtml = isHtml(artifact.name, artifact.contentType);
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-security-policy': interactiveHtml
                    ? "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
                    : "sandbox allow-downloads; default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'",
                'x-content-type-options': 'nosniff',
                'cache-control': 'no-store'
            });
            res.end(interactiveHtml ? content : staticPreview(artifact, content, this.url(artifact, 'download')));
            return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        res.end(content);
    }

    async stop() {
        await this.dynamic.stop();
        const server = this.server;
        this.server = null; this.port = null; this.token = null;
        if (server) await new Promise((resolve) => server.close(() => resolve()));
        this.artifacts.clear();
    }
}

module.exports = ArtifactService;
