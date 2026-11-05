const crypto = require('crypto');
const http = require('http');

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            size += Buffer.byteLength(chunk, 'utf8');
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body is too large.'));
                request.destroy();
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Request body must be valid JSON.'));
            }
        });
        request.on('error', reject);
    });
}

function respond(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body, 'utf8'),
        'cache-control': 'no-store'
    });
    response.end(body);
}

class BrowserRemoteService {
    constructor({ requestBrowserTool, logger = console }) {
        if (typeof requestBrowserTool !== 'function') {
            throw new Error('BrowserRemoteService requires requestBrowserTool.');
        }
        this.requestBrowserTool = requestBrowserTool;
        this.logger = logger;
        this.server = null;
        this.port = null;
        this.token = null;
        this.activeRequestControllers = new Set();
    }

    async start() {
        if (this.server && this.port && this.token) {
            return this.getConnectionInfo();
        }

        this.token = crypto.randomBytes(32).toString('base64url');
        this.server = http.createServer((request, response) => {
            this.handleRequest(request, response).catch((error) => {
                this.logger.warn(`[BrowserRemote] Request failed: ${error?.message || error}`);
                if (!response.headersSent) {
                    respond(response, 400, { ok: false, error: { code: 'bad_request', message: error.message || String(error) } });
                } else {
                    response.end();
                }
            });
        });

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                const address = this.server.address();
                this.port = typeof address === 'object' && address ? address.port : null;
                resolve();
            });
        });

        if (!this.port) {
            throw new Error('Could not determine browser remote service port.');
        }

        return this.getConnectionInfo();
    }

    getConnectionInfo() {
        if (!this.port || !this.token) {
            throw new Error('Browser remote service is not running.');
        }
        return {
            url: `http://127.0.0.1:${this.port}/tool`,
            token: this.token
        };
    }

    isAuthorized(request) {
        const supplied = String(request.headers['x-browser-remote-token'] || '');
        if (!supplied || !this.token || supplied.length !== this.token.length) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token));
    }

    async handleRequest(request, response) {
        if (request.method === 'GET' && request.url === '/health') {
            respond(response, 200, { ok: true });
            return;
        }

        if (request.method !== 'POST' || request.url !== '/tool') {
            respond(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown endpoint.' } });
            return;
        }

        if (!this.isAuthorized(request)) {
            respond(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Unauthorized browser bridge request.' } });
            return;
        }

        const payload = await readJsonBody(request);
        const tool = typeof payload.tool === 'string' ? payload.tool.trim() : '';
        const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {};
        if (!tool || tool.length > 100) {
            respond(response, 400, { ok: false, error: { code: 'invalid_tool', message: 'A valid tool name is required.' } });
            return;
        }

        const controller = new AbortController();
        const abort = () => controller.abort('The MCP client disconnected.');
        request.once('aborted', abort);
        response.once('close', () => {
            if (!response.writableEnded) abort();
        });
        this.activeRequestControllers.add(controller);
        try {
            const result = await this.requestBrowserTool({ tool, args, timeoutMs: DEFAULT_TIMEOUT_MS, signal: controller.signal });
            if (!response.destroyed) {
                respond(response, 200, result);
            }
        } finally {
            request.removeListener('aborted', abort);
            this.activeRequestControllers.delete(controller);
        }
    }

    async stop() {
        const server = this.server;
        this.server = null;
        this.port = null;
        this.token = null;
        for (const controller of this.activeRequestControllers) {
            controller.abort('The browser remote service is stopping.');
        }
        this.activeRequestControllers.clear();
        if (!server) {
            return;
        }
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
    }
}

module.exports = BrowserRemoteService;
