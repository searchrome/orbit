const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = { mode: 'open', intervalMinutes: 60, background: false };
function bounded(value, limit, field) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${field}`);
    return value;
}
function sourceDefinition(source) {
    const url = new URL(bounded(source.url, 8192, 'source URL'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source must be an HTTP(S) page');
    return { id: bounded(source.id, 80, 'source id'), url: url.href,
        selector: source.selector ? bounded(source.selector, 1000, 'selector') : '',
        kind: source.kind === 'elements' ? 'elements' : 'text' };
}

class DynamicArtifactService {
    constructor({ directory, requestBrowserTool }) {
        this.directory = directory;
        this.requestBrowserTool = requestBrowserTool;
        this.tokens = new Map();
        this.leases = new Map();
        this.jobs = new Map();
        this.sourceJobs = new Map();
        this.tail = Promise.resolve();
    }
    start() {
        if (this.db) return;
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path.join(this.directory, 'dynamic-artifacts.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, definition TEXT NOT NULL, settings TEXT NOT NULL, snapshot TEXT NOT NULL DEFAULT '{}', last_success INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS records(app_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(app_id,key));`);
        this.timer = setInterval(() => this.tick(), 30000);
        this.timer.unref?.();
    }
    get(id) {
        const row = this.db.prepare('SELECT * FROM apps WHERE id=?').get(id);
        if (!row) throw new Error('Dynamic artifact not found');
        return { ...row, definition: JSON.parse(row.definition), settings: JSON.parse(row.settings), snapshot: JSON.parse(row.snapshot) };
    }
    token(id) {
        if (!this.tokens.has(id)) this.tokens.set(id, crypto.randomBytes(24).toString('base64url'));
        return this.tokens.get(id);
    }
    describe(row) {
        return { id: row.id, name: row.definition.name, dynamic: true, html: true, contentType: 'Dynamic web app', size: Buffer.byteLength(row.definition.html), revision: row.definition.revision, createdAt: row.definition.createdAt };
    }
    list() { return this.db.prepare('SELECT id FROM apps').all().map(({ id }) => this.describe(this.get(id))); }
    save(input, id) {
        const existing = id ? this.get(id) : null;
        if (existing && input.expectedRevision !== existing.definition.revision) throw new Error('App changed; get its latest revision first');
        if (!existing && this.list().length >= 100) throw new Error('Maximum of 100 dynamic apps');
        const sources = input.sources || [];
        if (!Array.isArray(sources) || sources.length > 6) throw new Error('At most six sources per app');
        const normalized = sources.map(sourceDefinition);
        if (new Set(normalized.map(s => s.id)).size !== normalized.length) throw new Error('Source IDs must be unique');
        const definition = { name: bounded(input.name, 180, 'name'), html: bounded(input.html, 500000, 'HTML'), sources: normalized,
            revision: (existing?.definition.revision || 0) + 1, createdAt: existing?.definition.createdAt || new Date().toISOString() };
        id ||= crypto.randomUUID();
        if (this.jobs.has(id)) throw new Error('Wait for the active refresh before updating');
        this.db.prepare(`INSERT INTO apps(id,definition,settings) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,snapshot='{}',last_success=0,error=''`)
            .run(id, JSON.stringify(definition), JSON.stringify(DEFAULT_SETTINGS));
        return this.describe(this.get(id));
    }
    remove(id) {
        this.get(id);
        if (this.jobs.has(id)) throw new Error('Wait for refresh to finish before deleting');
        this.db.prepare('DELETE FROM records WHERE app_id=?').run(id);
        this.db.prepare('DELETE FROM apps WHERE id=?').run(id);
        this.tokens.delete(id); this.leases.delete(id);
    }
    settings(id, input) {
        const row = this.get(id);
        if (!['open', 'daily', 'interval', 'manual'].includes(input.mode)) throw new Error('Invalid refresh mode');
        const settings = { mode: input.mode, intervalMinutes: Math.max(15, Math.min(1440, Number(input.intervalMinutes) || 60)), background: input.background === true };
        this.db.prepare('UPDATE apps SET settings=? WHERE id=?').run(JSON.stringify(settings), row.id);
        return settings;
    }
    state(id) {
        const row = this.get(id);
        const scheduled = ['daily', 'interval'].includes(row.settings.mode);
        const active = (this.leases.get(id) || 0) > Date.now() - 45000 || row.settings.background;
        const nextRefresh = scheduled && active ? Math.max(Date.now(), Math.max(row.last_success, row.last_attempt) + (row.settings.mode === 'daily' ? 86400000 : row.settings.intervalMinutes * 60000)) : null;
        return { sources: row.snapshot, settings: row.settings, lastSuccess: row.last_success, lastAttempt: row.last_attempt,
            nextRefresh, error: row.error, refreshing: this.jobs.has(id), storageBytes: this.db.prepare('SELECT coalesce(sum(length(value)),0) AS size FROM records WHERE app_id=?').get(id).size };
    }
    storage(id, method, key, value) {
        this.get(id); bounded(key, 100, 'storage key');
        if (method === 'get') {
            const row = this.db.prepare('SELECT value FROM records WHERE app_id=? AND key=?').get(id, key);
            return row ? JSON.parse(row.value) : null;
        }
        if (method !== 'set') throw new Error('Unknown storage operation');
        const encoded = JSON.stringify(value ?? null);
        if (Buffer.byteLength(encoded) > 100000) throw new Error('A record may contain at most 100 KB');
        const usage = this.db.prepare('SELECT coalesce(sum(length(value)),0) AS size,count(*) AS count FROM records WHERE app_id=? AND key!=?').get(id, key);
        if (usage.size + encoded.length > 1000000 || usage.count >= 100) throw new Error('App storage quota exceeded (1 MB / 100 records)');
        this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(app_id,key) DO UPDATE SET value=excluded.value').run(id, key, encoded);
        return true;
    }
    async readSource(source) {
        // Share concurrent reads only. Persistent snapshots remain scoped to each app.
        const key = JSON.stringify({ url: source.url, selector: source.selector, kind: source.kind });
        if (this.sourceJobs.has(key)) return this.sourceJobs.get(key);
        const pending = this.tail.catch(() => {}).then(async () => {
            const call = async (tool, args) => {
                const result = await this.requestBrowserTool({ tool, args, timeoutMs: 20000 });
                if (result?.ok === false) throw new Error(result.error?.message || 'Source read failed');
                return result;
            };
            const listed = await call('list_tabs', {});
            const tabs = listed.tabs || listed.data?.tabs || (Array.isArray(listed.data) ? listed.data : []);
            const tab = tabs.find(t => !t.internal && t.url === source.url);
            if (!tab) throw new Error(`Open the source page to refresh: ${source.url}`);
            const result = source.kind === 'elements'
                ? await call('query_selector_all', { tabId: tab.id, selector: source.selector || 'a', fields: ['text', 'href', 'title'], maxResults: 100, maxOutputChars: 20000 })
                : await call('read_page_text', { tabId: tab.id, maxChars: 20000, ...(source.selector ? { selector: source.selector } : {}) });
            const info = await call('get_tab_info', { tabId: tab.id });
            const current = info.tab || info.data?.tab || info.data;
            if (current?.url !== source.url) throw new Error('Source navigated during refresh; retry');
            if (JSON.stringify(result).length > 64000) throw new Error('Source result exceeds size limit');
            return { url: source.url, fetchedAt: Date.now(), result };
        });
        this.tail = pending;
        this.sourceJobs.set(key, pending);
        try { return await pending; } finally { this.sourceJobs.delete(key); }
    }
    refresh(id) {
        if (this.jobs.has(id)) return this.jobs.get(id);
        if (this.jobs.size >= 4) return Promise.reject(new Error('Refresh queue busy; try again shortly'));
        const row = this.get(id);
        if (Date.now() - row.last_attempt < 15000) return Promise.resolve(this.state(id));
        this.db.prepare('UPDATE apps SET last_attempt=? WHERE id=?').run(Date.now(), id);
        const job = (async () => {
            const snapshot = { ...row.snapshot }; const errors = [];
            for (const source of row.definition.sources) {
                try { snapshot[source.id] = await this.readSource(source); }
                catch (error) { errors.push(`${source.id}: ${error.message}`); }
            }
            this.db.prepare('UPDATE apps SET snapshot=?,last_success=?,error=? WHERE id=?')
                .run(JSON.stringify(snapshot), errors.length ? row.last_success : Date.now(), errors.join('\n'), id);
        })();
        const finished = job.finally(() => this.jobs.delete(id)).then(() => this.state(id));
        this.jobs.set(id, finished);
        return finished;
    }
    tick() {
        for (const { id } of this.list()) {
            const row = this.get(id);
            const open = (this.leases.get(id) || 0) > Date.now() - 45000;
            const period = row.settings.mode === 'daily' ? 86400000 : row.settings.intervalMinutes * 60000;
            if ((open || row.settings.background) && ['daily', 'interval'].includes(row.settings.mode)
                && Date.now() - Math.max(row.last_attempt, row.last_success) >= period) this.refresh(id).catch(() => {});
        }
    }
    async stop() {
        clearInterval(this.timer);
        await Promise.allSettled([...this.jobs.values()]);
        this.db?.close(); this.db = null;
        this.tokens.clear(); this.leases.clear();
    }
}
module.exports = DynamicArtifactService;
