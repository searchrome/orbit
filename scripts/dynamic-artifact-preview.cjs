// Local-only UI fixture using synthetic source data; never touches the user's profile.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ArtifactService = require('../artifact-service');
(async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dynamic-ui-preview-'));
    const service = new ArtifactService({ app: { getPath: () => directory }, requestBrowserTool: async ({ tool }) => {
        if (tool === 'list_tabs') return { ok: true, data: { tabs: [{ id: 'fixture', url: 'https://example.com/news' }] } };
        if (tool === 'get_tab_info') return { ok: true, data: { id: 'fixture', url: 'https://example.com/news' } };
        return { ok: true, data: { text: 'Synthetic news source — SDK and refresh smoke test.' } };
    } });
    await service.start();
    const html = await fs.readFile(path.join(__dirname, '../dynamic-artifact-starter.html'), 'utf8');
    const app = service.dynamic.save({ name: 'Dynamic app · test fixture', html, sources: [{ id: 'news', url: 'https://example.com/news' }] });
    console.log(`http://127.0.0.1:${service.port}/artifact/${app.id}/${service.dynamic.token(app.id)}/view`);
    const stop = async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); process.exit(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
})().catch(error => { console.error(error); process.exitCode = 1; });
