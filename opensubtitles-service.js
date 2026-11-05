const fs = require('fs');
const path = require('path');
const { parseWebVtt } = require('./subtitle-converter');

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Entrim Browser v1.0.0';
const MAX_API_KEY_LENGTH = 256;
const DEFAULT_LANGUAGES = 'en';
const ZIP_SIGNATURE = 'PK';
const SUBTITLES_DEBUG_LOG = '/tmp/cast-subtitles-debug.log';

function osDebug(message) {
    try {
        fs.appendFileSync(SUBTITLES_DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never break casting.
    }
}

// Finds captions on OpenSubtitles for videos the page player does not expose,
// and stores the API key with the operating system's secure credential storage
// (same scheme as the OpenCode provider keys).
class OpenSubtitlesService {
    constructor({ app, secretStorage, logger = console, fetchImpl = globalThis.fetch } = {}) {
        this.app = app;
        this.secretStorage = secretStorage;
        this.logger = logger;
        this.fetchImpl = fetchImpl;
    }

    get credentialsPath() {
        return path.join(this.app.getPath('userData'), 'cast-credentials.json');
    }

    canStoreCredentials() {
        try {
            return !!this.secretStorage?.isEncryptionAvailable?.();
        } catch (error) {
            this.logger.warn(`[Cast] Secure credential storage is unavailable: ${error?.message || error}`);
            return false;
        }
    }

    async readSavedKey() {
        if (!this.canStoreCredentials()) return '';
        try {
            const raw = await fs.promises.readFile(this.credentialsPath, 'utf8');
            const parsed = JSON.parse(raw);
            const encoded = typeof parsed?.openSubtitlesApiKey === 'string' ? parsed.openSubtitlesApiKey : '';
            if (!encoded) return '';
            return this.secretStorage.decryptString(Buffer.from(encoded, 'base64')).trim();
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                this.logger.warn(`[Cast] Could not read the saved OpenSubtitles key: ${error?.message || error}`);
            }
            return '';
        }
    }

    async writeSavedKey(key) {
        if (!this.canStoreCredentials()) {
            throw new Error('Secure credential storage is unavailable on this device.');
        }
        const encrypted = this.secretStorage.encryptString(key).toString('base64');
        await fs.promises.mkdir(path.dirname(this.credentialsPath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(
            this.credentialsPath,
            `${JSON.stringify({ version: 1, openSubtitlesApiKey: encrypted }, null, 2)}\n`,
            { mode: 0o600 }
        );
        await fs.promises.chmod(this.credentialsPath, 0o600);
    }

    async getSettings() {
        const key = await this.readSavedKey();
        return {
            openSubtitlesKeyConfigured: !!key,
            secureCredentialStorageAvailable: this.canStoreCredentials()
        };
    }

    async saveSettings(nextSettings = {}) {
        const hasNewKey = Object.prototype.hasOwnProperty.call(nextSettings, 'openSubtitlesApiKey');
        const nextKey = hasNewKey ? String(nextSettings.openSubtitlesApiKey || '').trim() : '';
        if (nextKey.length > MAX_API_KEY_LENGTH) throw new Error('The OpenSubtitles API key is too long.');

        if (nextKey) {
            await this.writeSavedKey(nextKey);
        } else if (nextSettings.clearOpenSubtitlesApiKey === true) {
            try {
                await fs.promises.unlink(this.credentialsPath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        return this.getSettings();
    }

    // Best-effort cleanup of player page titles: drop leading call-to-action
    // junk ("Watch …"), season/episode fragments (passed as dedicated
    // parameters), years, and trailing site promotions.
    static cleanSearchTitle(title) {
        return String(title || '')
            .replace(/^\s*(watch|stream|online|free|full|download|putlocker)\b[\s:—-]*/i, '')
            .replace(/\bs\d{1,2}\s?[-_. ]?e\d{1,3}\b.*$/i, '')
            .replace(/\bseason\s*[-_. ]?\d+\b.*$/i, '')
            .replace(/\b\d{4}\b/g, '')
            .replace(/\(\s*\)/g, '')
            .replace(/[-–—|:]\s*(watch|stream|online|free|hd|full|series|movie|episode).*$/i, '')
            .replace(/[\s\-–—|:,]+$/, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    static extractEpisodeMeta(url = '', title = '') {
        const haystack = `${url} ${title}`;
        const imdb = /tt(\d{5,})/i.exec(haystack);
        let season = null;
        let episode = null;
        const sxe = /[Ss](\d{1,2})[\ ._-]?[Ee](\d{1,3})/.exec(haystack);
        const spelled = /[Ss]eason[\ ._-]*0*(\d{1,2}).{0,20}?[Ee]pisode[\ ._-]*0*(\d{1,3})/.exec(haystack);
        // Embedders like vidsrc place them positionally: /tv/tt5875444/6/1
        const pathIds = /tt\d{5,}\/(\d{1,2})\/(\d{1,3})/.exec(haystack);
        if (sxe) {
            season = Number(sxe[1]);
            episode = Number(sxe[2]);
        } else if (spelled) {
            season = Number(spelled[1]);
            episode = Number(spelled[2]);
        } else if (pathIds) {
            season = Number(pathIds[1]);
            episode = Number(pathIds[2]);
        }
        return {
            imdbId: imdb ? `tt${imdb[1]}` : '',
            season: Number.isInteger(season) ? season : null,
            episode: Number.isInteger(episode) ? episode : null
        };
    }

    async apiRequest(pathname, params, label = 'OpenSubtitles request') {
        const key = await this.readSavedKey();
        if (!key) throw new Error('Add your OpenSubtitles API key in Settings.');
        const url = new URL(`${API_BASE}${pathname}`);
        for (const [name, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
        }
        // The key travels in a header; the URL is safe to log.
        osDebug(`GET ${pathname} ${url.search} key=${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)`);
        const response = await this.fetchImpl(url, {
            headers: { 'Api-Key': key, 'User-Agent': USER_AGENT, Accept: 'application/json' }
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            osDebug(`${pathname} → HTTP ${response.status} ${detail.slice(0, 160)}`);
            const reason = /401|403/.test(String(response.status))
                ? 'OpenSubtitles rejected the API key. Check it in Settings.'
                : `${label} failed (HTTP ${response.status}).`;
            throw new Error(`${reason} ${detail.slice(0, 120)}`.trim());
        }
        const payload = await response.json();
        osDebug(`${pathname} → OK`);
        return payload;
    }

    async downloadSrt(fileId) {
        const key = await this.readSavedKey();
        if (!key) throw new Error('Add your OpenSubtitles API key in Settings.');
        // OpenSubtitles' download route takes a POST with a JSON body; the old
        // GET ?file_id= form now answers 404 for every file.
        const response = await this.fetchImpl(`${API_BASE}/download`, {
            method: 'POST',
            headers: { 'Api-Key': key, 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: fileId })
        });
        osDebug(`POST /download file_id=${fileId} → HTTP ${response.status}`);
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            osDebug(`/download → ${detail.slice(0, 160)}`);
            throw new Error(`OpenSubtitles download failed (HTTP ${response.status}). ${detail.slice(0, 100)}`.trim());
        }
        const download = await response.json();
        if (!download?.link) throw new Error('OpenSubtitles did not return a download link.');
        const content = await this.fetchImpl(download.link, { headers: { 'User-Agent': USER_AGENT } });
        osDebug(`file ${fileId} content fetch → HTTP ${content.status} (${download.file_name || 'unknown name'})`);
        if (!content.ok) throw new Error(`The subtitle file could not be fetched (HTTP ${content.status}).`);
        const buffer = Buffer.from(await content.arrayBuffer());
        if (buffer.subarray(0, 2).toString() === ZIP_SIGNATURE) {
            throw new Error('That subtitle is a zip archive; pick another one.');
        }
        return buffer.toString('utf8');
    }

    // Editable search: returns a normalized result list the user picks from.
    // Each result carries one downloadable file id (plain .srt preferred, but a
    // zip entry is still listed — if its download fails the user simply picks
    // another row, which beats silently auto-choosing).
    async search({ title, url, query, imdbId, season, episode, languages = DEFAULT_LANGUAGES } = {}) {
        // A typed query may itself contain S/E markers ("South Park S28E1 …");
        // lift them into dedicated params and clean the query text either way.
        const raw = String(query || '').trim() || String(title || '');
        const meta = OpenSubtitlesService.extractEpisodeMeta(url, `${title || ''} ${raw}`);
        if (!imdbId && meta.imdbId) imdbId = meta.imdbId;
        if (season == null && meta.season != null) season = meta.season;
        if (episode == null && meta.episode != null) episode = meta.episode;
        const text = OpenSubtitlesService.cleanSearchTitle(raw);

        const params = { languages };
        if (imdbId) {
            params.imdb_id = String(imdbId).replace(/^tt/i, '');
        } else if (text) {
            params.query = text;
        }
        // The API expects season_number/episode_number (season/episode are
        // silently ignored), and they apply to query searches too.
        if (season != null) params.season_number = season;
        if (episode != null) params.episode_number = episode;
        if (!params.imdb_id && !params.query) {
            throw new Error('Type a show or movie name to search subtitles for.');
        }

        const response = await this.apiRequest('/subtitles', params, 'OpenSubtitles search');
        const entries = Array.isArray(response?.data) ? response.data : [];
        osDebug(`search returned ${entries.length} result(s) for params=${JSON.stringify(params)}`);

        const results = [];
        for (const entry of entries.slice(0, 15)) {
            const attrs = entry?.attributes || {};
            const feature = attrs.feature_details || {};
            const files = (Array.isArray(attrs.files) ? attrs.files : [])
                .filter((file) => Number.isInteger(file?.file_id))
                .sort((a, b) => (/\.srt$/i.test(String(b.file_name || '')) ? 1 : 0) - (/\.srt$/i.test(String(a.file_name || '')) ? 1 : 0));
            const file = files[0];
            if (!file) continue;
            results.push({
                fileId: file.file_id,
                label: attrs.release || file.file_name || 'OpenSubtitles',
                fileName: file.file_name || '',
                language: attrs.language || '',
                feature: feature.title || '',
                year: feature.year || null,
                season: feature.season_number ?? null,
                episode: feature.episode_number ?? null,
                hearingImpaired: !!attrs.hearing_impaired,
                aiTranslated: !!attrs.ai_translated
            });
        }
        if (!results.length) throw new Error('No OpenSubtitles results for this search.');
        return { results, searchedWith: params };
    }
}

module.exports = { OpenSubtitlesService };
