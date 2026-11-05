// Trusted shared chrome and SDK. Generated HTML lives in an opaque sandboxed iframe.
const literal = value => JSON.stringify(value).replace(/</g, '\\u003c');

function sdk() {
    const requests = new Map(); let sequence = 0;
    const baseUrl = new URL(document.baseURI);
    const navigationNotice = 'External links are unavailable inside dynamic artifacts. Add the page as a declared source and use its Open source button.';
    const anchorFromEvent = event => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        return path.find(node => node?.tagName === 'A' && node.hasAttribute?.('href')) || event.target?.closest?.('a[href]') || null;
    };
    const isLocalFragment = anchor => {
        const href = anchor.getAttribute('href')?.trim();
        if (!href || href === '#') return true;
        try {
            const target = new URL(href, document.baseURI);
            return target.origin === baseUrl.origin
                && target.pathname === baseUrl.pathname
                && target.search === baseUrl.search
                && Boolean(target.hash);
        } catch {
            return false;
        }
    };
    const reportBlockedNavigation = href => {
        console.warn(navigationNotice, href || '');
        window.dispatchEvent(new CustomEvent('artifact-navigation-blocked', { detail: { href: href || null } }));
        parent.postMessage({ dynamicArtifact: true, event: 'navigation-blocked', href: href || null }, '*');
    };
    const blockExternalLink = event => {
        const anchor = anchorFromEvent(event);
        if (!anchor || isLocalFragment(anchor)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        reportBlockedNavigation(anchor.href || anchor.getAttribute('href'));
    };
    // The generated app is a data-only view. Keep fragment navigation for local
    // list/detail views, but never let app code take the iframe to another site.
    document.addEventListener('click', blockExternalLink, true);
    document.addEventListener('auxclick', blockExternalLink, true);
    window.open = url => { reportBlockedNavigation(url); return null; };
    function call(method, args = {}) {
        if (requests.size >= 20) return Promise.reject(new Error('Too many pending requests'));
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { requests.delete(id); reject(new Error('App request timed out')); }, 30000);
            requests.set(id, { resolve, reject, timer });
            parent.postMessage({ dynamicArtifact: true, id, method, args }, '*');
        });
    }
    window.addEventListener('message', event => {
        if (event.source !== parent || !event.data?.dynamicArtifact) return;
        if (event.data.event === 'data') { window.dispatchEvent(new CustomEvent('artifact-data', { detail: event.data.value })); return; }
        const pending = requests.get(event.data.id);
        if (!pending) return;
        clearTimeout(pending.timer); requests.delete(event.data.id);
        event.data.error ? pending.reject(new Error(event.data.error)) : pending.resolve(event.data.value);
    });
    window.artifact = Object.freeze({
        data: () => call('state'), refresh: () => call('refresh'),
        storage: Object.freeze({ get: key => call('get', { key }), set: (key, value) => call('set', { key, value }) }),
        subscribe: listener => { const handler = event => listener(event.detail); window.addEventListener('artifact-data', handler); return () => window.removeEventListener('artifact-data', handler); }
    });
}

function frameScript(config) {
    const frame = document.getElementById('app');
    const status = document.getElementById('status');
    let lastState = ''; let busy = false; let calls = 0;
    setInterval(() => { calls = 0; }, 1000);
    async function api(method, args = {}) {
        const response = await fetch('api', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dynamic-request': '1' }, body: JSON.stringify({ method, ...args }) });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'Request failed');
        return result.value;
    }
    async function update(opening = false) {
        if (busy) return;
        busy = true;
        try {
            const value = await api('heartbeat', { opening });
            status.textContent = (value.refreshing ? 'Refreshing… ' : '') + (value.lastSuccess ? `Updated ${new Date(value.lastSuccess).toLocaleString()}` : 'No successful refresh yet') + (value.nextRefresh ? ` · Next ${new Date(value.nextRefresh).toLocaleString()}` : '') + ` · ${value.storageBytes} bytes saved` + (value.error ? ` · ${value.error}` : '');
            if (JSON.stringify(value) !== lastState) {
                lastState = JSON.stringify(value);
                frame.contentWindow.postMessage({ dynamicArtifact: true, event: 'data', value }, '*');
            }
        } catch (error) { status.textContent = error.message; }
        finally { busy = false; }
    }
    window.addEventListener('message', async event => {
        const message = event.data;
        if (event.source !== frame.contentWindow || !message?.dynamicArtifact) return;
        if (message.event === 'navigation-blocked') {
            status.textContent = 'External links are unavailable in dynamic artifacts. Use a declared source and its Open source button.';
            return;
        }
        if (!Number.isInteger(message.id)) return;
        if (++calls > 20) return;
        try {
            if (!['state', 'refresh', 'get', 'set'].includes(message.method)) throw new Error('Unsupported app operation');
            const value = await api(message.method, { key: message.args?.key, value: message.args?.value });
            frame.contentWindow.postMessage({ dynamicArtifact: true, id: message.id, value }, '*');
        } catch (error) { frame.contentWindow.postMessage({ dynamicArtifact: true, id: message.id, error: error.message }, '*'); }
    });
    document.getElementById('name').textContent = config.name;
    document.getElementById('refresh').onclick = async () => {
        status.textContent = 'Refreshing…';
        try { await api('refresh'); await update(); } catch (error) { status.textContent = error.message; }
    };
    const mode = document.getElementById('mode'); const interval = document.getElementById('interval'); const background = document.getElementById('background');
    mode.value = config.settings.mode; interval.value = config.settings.intervalMinutes; background.checked = config.settings.background;
    document.getElementById('settings').onsubmit = async event => {
        event.preventDefault();
        try { await api('settings', { settings: { mode: mode.value, intervalMinutes: Number(interval.value), background: background.checked } }); status.textContent = 'Settings saved'; }
        catch (error) { status.textContent = error.message; }
    };
    for (const source of config.sources) {
        const button = document.createElement('button'); button.textContent = `Open ${source.id}`;
        button.onclick = async event => {
            if (!event.isTrusted) return;
            try { await api('open-source', { sourceId: source.id }); } catch (error) { status.textContent = error.message; }
        };
        document.getElementById('sources').append(button);
    }
    frame.srcdoc = config.document;
    update(true);
    setInterval(() => update(), 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
}

function renderFrame(row) {
    const restriction = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">`;
    const document = restriction + '<script>(' + sdk.toString() + ')();</script>' + row.definition.html;
    const config = { name: row.definition.name, sources: row.definition.sources, settings: row.settings, document };
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Dynamic web artifact</title><style>
    body{margin:0;font:13px system-ui;color:#172033;background:#f8fafc;height:100vh;display:flex;flex-direction:column}header{padding:10px 14px;border-bottom:1px solid #dbe3ee}button,select,input{font:inherit;padding:5px 8px}button{cursor:pointer}#status{font-size:12px;color:#526176;white-space:pre-wrap;margin-top:7px}#app{flex:1;width:100%;border:0;background:white}form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0}#sources{display:inline-flex;gap:5px}summary{cursor:pointer}input[type=number]{width:65px}</style></head><body>
    <header><strong id="name"></strong> <button id="refresh">Refresh now</button> <span id="sources"></span><details><summary>App settings</summary><form id="settings"><label>Refresh <select id="mode"><option value="open">Each time opened</option><option value="daily">Once a day</option><option value="interval">At an interval</option><option value="manual">Manual only</option></select></label><label>Interval (minutes) <input id="interval" type="number" min="15" max="1440"></label><label><input type="checkbox" id="background">Keep sources updated while closed</label><button>Save settings</button></form><small>Sources must be open in the browser. Background work stops when the browser exits.</small></details><div id="status" role="status"></div></header>
    <iframe id="app" title="Dynamic artifact application" sandbox="allow-scripts"></iframe><script>(${frameScript.toString()})(${literal(config)});</script></body></html>`;
}
module.exports = { renderFrame, sdk };
