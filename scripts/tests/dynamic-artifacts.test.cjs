const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const ArtifactService = require('../../artifact-service');
const { sdk } = require('../../dynamic-artifact-frame');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-artifact-test-'));
    let currentUrl = 'https://example.com/news';
    let reads = 0;
    const service = new ArtifactService({ app: { getPath: () => directory }, requestBrowserTool: async ({ tool, args }) => {
        if (tool === 'list_tabs') return { ok: true, data: { tabs: [{ id: 'tab-1', url: currentUrl }] } };
        if (tool === 'get_tab_info') return { ok: true, data: { id: 'tab-1', url: currentUrl } };
        if (tool === 'read_page_text') { reads++; return { ok: true, data: { text: 'Fresh news', tabId: args.tabId } }; }
        return { ok: true };
    } });
    await service.start();
    t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    const create = (name = 'News') => service.dynamic.save({ name, html: '<h1>News</h1>', sources: [{ id: 'news', url: 'https://example.com/news' }] });
    const url = app => `http://127.0.0.1:${service.port}/artifact/${app.id}/${service.dynamic.token(app.id)}`;
    const api = (app, body, origin = `http://127.0.0.1:${service.port}`) => fetch(url(app) + '/api', { method: 'POST', headers: { origin, 'x-dynamic-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { service, create, url, api, navigate: url => { currentUrl = url; }, reads: () => reads };
}

test('shared server serves isolated frame and rejects cross-origin/missing capability requests', async t => {
    const f = await fixture(t); const app = f.create();
    const view = await fetch(f.url(app) + '/view');
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await view.text();
    assert.match(html, /sandbox="allow-scripts"/);
    assert.match(html, /window.artifact/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /artifact-navigation-blocked/);
    assert.match(html, /External links are unavailable/);
    assert.equal((await f.api(app, { method: 'state' }, 'https://attacker.example')).status, 403);
    assert.equal((await fetch(f.url(app).replace(f.service.dynamic.token(app.id), 'wrong') + '/view')).status, 404);
    assert.equal((await f.api(app, { method: 'click_element', selector: 'button' })).status, 400);
});

test('generated apps allow local fragments but explain blocked external links and popups', () => {
    const dom = new JSDOM('<a id="local" href="#list">Local list</a><a id="external" href="https://example.com/out" target="_blank">Outside</a>', {
        url: 'http://127.0.0.1:51000/artifact/app/token/view',
        runScripts: 'outside-only'
    });
    dom.window.eval(`(${sdk.toString()})();`);

    const local = dom.window.document.getElementById('local');
    const external = dom.window.document.getElementById('external');
    let localClicks = 0;
    let externalClicks = 0;
    let blockedHref = null;
    local.addEventListener('click', () => { localClicks++; });
    external.addEventListener('click', () => { externalClicks++; });
    dom.window.addEventListener('artifact-navigation-blocked', event => { blockedHref = event.detail.href; });

    assert.equal(local.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })), true);
    assert.equal(localClicks, 1);
    assert.equal(external.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })), false);
    assert.equal(externalClicks, 0);
    assert.equal(blockedHref, 'https://example.com/out');
    assert.equal(dom.window.open('https://example.com/popup'), null);
});

test('SQLite storage is app-scoped, bounded and persists with settings across restarts', async t => {
    const f = await fixture(t); const a = f.create(); const b = f.create('Other');
    await f.api(a, { method: 'set', key: 'note', value: 'Saved note' });
    assert.equal((await (await f.api(b, { method: 'get', key: 'note' })).json()).value, null);
    assert.equal((await f.api(a, { method: 'set', key: 'large', value: 'x'.repeat(100001) })).status, 400);
    await f.api(a, { method: 'settings', settings: { mode: 'daily', background: true } });
    await f.service.stop(); await f.service.start();
    assert.equal(f.service.dynamic.storage(a.id, 'get', 'note'), 'Saved note');
    assert.equal(f.service.dynamic.get(a.id).settings.mode, 'daily');
    assert.equal(f.service.dynamic.list().length, 2);
});

test('refresh reads declared live source, preserves cached data on source loss and prevents stale revisions', async t => {
    const f = await fixture(t); const a = f.create();
    let state = await f.service.dynamic.refresh(a.id);
    assert.equal(state.sources.news.result.data.text, 'Fresh news');
    assert.equal(f.reads(), 1);
    f.navigate('https://example.com/private');
    f.service.dynamic.db.prepare('UPDATE apps SET last_attempt=0 WHERE id=?').run(a.id);
    state = await f.service.dynamic.refresh(a.id);
    assert.match(state.error, /Open the source page/);
    assert.equal(state.sources.news.result.data.text, 'Fresh news');
    assert.equal(f.reads(), 1);
    assert.throws(() => f.service.dynamic.save({ name: 'Changed', html: 'x', expectedRevision: 0 }, a.id), /revision/);
    const updated = f.service.dynamic.save({ name: 'Changed', html: 'x', expectedRevision: 1 }, a.id);
    assert.equal(updated.revision, 2);
});

test('manual mode does not refresh on opening; daily due refresh starts on opening', async t => {
    const f = await fixture(t); const a = f.create();
    f.service.dynamic.settings(a.id, { mode: 'manual' });
    await f.api(a, { method: 'heartbeat', opening: true });
    assert.equal(f.reads(), 0);
    f.service.dynamic.settings(a.id, { mode: 'daily' });
    await f.api(a, { method: 'heartbeat', opening: true });
    await Promise.all([...f.service.dynamic.jobs.values()]);
    assert.equal(f.reads(), 1);
});

test('closed apps stay idle unless background is enabled; concurrent apps share source reads', async t => {
    const f = await fixture(t); const a = f.create(); const b = f.create('Other');
    f.service.dynamic.settings(a.id, { mode: 'daily' });
    f.service.dynamic.tick();
    assert.equal(f.reads(), 0);
    f.service.dynamic.settings(a.id, { mode: 'daily', background: true });
    f.service.dynamic.settings(b.id, { mode: 'daily', background: true });
    f.service.dynamic.tick();
    await Promise.all([...f.service.dynamic.jobs.values()]);
    assert.equal(f.reads(), 1);
    assert.equal(f.service.dynamic.state(a.id).sources.news.result.data.text, 'Fresh news');
    assert.equal(f.service.dynamic.state(b.id).sources.news.result.data.text, 'Fresh news');
});

test('MCP guide/create/update/list/open path preserves app identity', async t => {
    const f = await fixture(t);
    const guide = await f.service.tool({ tool: 'get_dynamic_artifact_guide' });
    assert.match(guide.starterHtml, /artifact.storage/);
    const created = await f.service.tool({ tool: 'create_dynamic_artifact', args: { name: 'App', html: guide.starterHtml, sources: [] } });
    const id = created.artifact.id;
    const loaded = await f.service.tool({ tool: 'get_dynamic_artifact', args: { id } });
    assert.equal(loaded.revision, 1);
    await f.service.tool({ tool: 'update_dynamic_artifact', args: { id, expectedRevision: 1, name: 'Updated', html: '<h1>Updated</h1>', sources: [] } });
    assert.equal((await f.service.tool({ tool: 'list_artifacts' })).artifacts[0].name, 'Updated');
    assert.equal((await f.service.open(id)).ok, true);
});
