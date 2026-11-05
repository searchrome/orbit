const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_VIEWS = 100;
const MAX_NAME_LENGTH = 160;
const MAX_URL_LENGTH = 8_192;
const MAX_SELECTOR_LENGTH = 1_000;
const MAX_REMOVE_SELECTORS = 40;

function text(value, maxLength, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
    const normalized = value.trim();
    if (normalized.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
    return normalized;
}

function httpUrl(value) {
    const url = text(value, MAX_URL_LENGTH, 'sourceUrl');
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('sourceUrl must be a valid HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('sourceUrl must use HTTP or HTTPS.');
    return parsed.toString();
}

function selector(value, field, fallback = '') {
    if (value === undefined || value === null || value === '') return fallback;
    return text(value, MAX_SELECTOR_LENGTH, field);
}

function recipeValue(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recipe must be an object.');
    const removeSelectors = value.removeSelectors === undefined ? [] : value.removeSelectors;
    if (!Array.isArray(removeSelectors) || removeSelectors.length > MAX_REMOVE_SELECTORS) {
        throw new Error(`recipe.removeSelectors must contain at most ${MAX_REMOVE_SELECTORS} selectors.`);
    }
    return {
        rootSelector: selector(value.rootSelector, 'recipe.rootSelector', 'main, article, [role="main"], body'),
        titleSelector: selector(value.titleSelector, 'recipe.titleSelector', 'h1'),
        readySelector: selector(value.readySelector, 'recipe.readySelector', ''),
        removeSelectors: removeSelectors.map((item, index) => selector(item, `recipe.removeSelectors[${index}]`)),
        theme: value.theme === 'dark' ? 'dark' : 'light'
    };
}

function describe(view) {
    return {
        id: view.id,
        name: view.name,
        sourceUrl: view.sourceUrl,
        recipe: view.recipe,
        revision: view.revision,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        lastSuccessAt: view.lastSuccessAt || null,
        lastSourceUrl: view.lastSourceUrl || null
    };
}

class TransformedViewService {
    constructor({ app, logger = console }) {
        this.app = app;
        this.logger = logger;
        this.views = new Map();
        this.loaded = false;
        this.writeQueue = Promise.resolve();
    }

    get filePath() {
        return path.join(this.app.getPath('userData'), 'transformed-views.json');
    }

    async load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            for (const saved of Array.isArray(parsed?.views) ? parsed.views.slice(0, MAX_VIEWS) : []) {
                try {
                    if (!/^[0-9a-f-]{36}$/i.test(String(saved?.id || ''))) throw new Error('invalid id');
                    this.views.set(saved.id, {
                        id: saved.id,
                        name: text(saved.name, MAX_NAME_LENGTH, 'name'),
                        sourceUrl: httpUrl(saved.sourceUrl),
                        recipe: recipeValue(saved.recipe),
                        revision: Math.max(1, Number(saved.revision) || 1),
                        createdAt: new Date(saved.createdAt).toISOString(),
                        updatedAt: new Date(saved.updatedAt).toISOString(),
                        lastSuccessAt: saved.lastSuccessAt ? new Date(saved.lastSuccessAt).toISOString() : null,
                        lastSourceUrl: saved.lastSourceUrl ? httpUrl(saved.lastSourceUrl) : null
                    });
                } catch {
                    // Skip a corrupt entry while preserving usable views.
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') this.logger.warn(`[TransformedViews] Could not load saved views: ${error?.message || error}`);
        }
    }

    async save() {
        const write = async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            const temporary = `${this.filePath}.tmp`;
            await fs.promises.writeFile(temporary, `${JSON.stringify({ version: 1, views: [...this.views.values()] }, null, 2)}\n`, { mode: 0o600 });
            await fs.promises.rename(temporary, this.filePath);
        };
        this.writeQueue = this.writeQueue.catch(() => undefined).then(write);
        return this.writeQueue;
    }

    async list() {
        await this.load();
        return [...this.views.values()]
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .map(describe);
    }

    async get(id) {
        await this.load();
        const view = this.views.get(String(id || ''));
        if (!view) throw new Error('Transformed view was not found.');
        return describe(view);
    }

    async create(input = {}) {
        await this.load();
        if (this.views.size >= MAX_VIEWS) throw new Error(`A maximum of ${MAX_VIEWS} transformed views can be saved.`);
        const now = new Date().toISOString();
        const view = {
            id: crypto.randomUUID(),
            name: text(input.name, MAX_NAME_LENGTH, 'name'),
            sourceUrl: httpUrl(input.sourceUrl),
            recipe: recipeValue(input.recipe),
            revision: 1,
            createdAt: now,
            updatedAt: now,
            lastSuccessAt: null,
            lastSourceUrl: null
        };
        this.views.set(view.id, view);
        await this.save();
        return describe(view);
    }

    async update(input = {}) {
        await this.load();
        const id = text(input.id, 80, 'id');
        const current = this.views.get(id);
        if (!current) throw new Error('Transformed view was not found.');
        const expectedRevision = Number(input.expectedRevision);
        if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
            throw new Error('This transformed view changed. Read it again before updating.');
        }
        current.name = input.name === undefined ? current.name : text(input.name, MAX_NAME_LENGTH, 'name');
        current.sourceUrl = input.sourceUrl === undefined ? current.sourceUrl : httpUrl(input.sourceUrl);
        current.recipe = input.recipe === undefined ? current.recipe : recipeValue(input.recipe);
        current.revision += 1;
        current.updatedAt = new Date().toISOString();
        await this.save();
        return describe(current);
    }

    async recordSuccess(id, sourceUrl) {
        await this.load();
        const current = this.views.get(String(id || ''));
        if (!current) return;
        current.lastSuccessAt = new Date().toISOString();
        current.lastSourceUrl = httpUrl(sourceUrl);
        await this.save();
    }
}

module.exports = TransformedViewService;
