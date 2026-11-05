jest.unmock('fs');
jest.unmock('path');

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ArtifactService = require('../../artifact-service');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('ArtifactService', () => {
  let userData;
  let service;

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-service-test-'));
    service = new ArtifactService({
      app: { getPath: jest.fn(() => userData) },
      requestBrowserTool: jest.fn().mockResolvedValue({ ok: true, data: { id: 'tab-artifact' } }),
      logger: { warn: jest.fn() }
    });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    await fs.rm(userData, { recursive: true, force: true });
  });

  test('creates direct UTF-8 text files with opaque preview and download URLs', async () => {
    const html = await service.create({ name: 'report.html', contentType: 'text/html', content: '<h1>Report</h1>' });
    const csv = await service.create({ name: 'report.csv', content: 'name,value\nBrowser,1' });

    expect(html.artifact.viewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(csv.artifact.viewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await service.tool({ tool: 'list_artifacts' })).artifacts).toHaveLength(2);

    const view = await get(html.artifact.viewUrl);
    expect(view.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(view.body.toString()).toBe('<h1>Report</h1>');
    const preview = await get(csv.artifact.viewUrl);
    expect(preview.headers['content-security-policy']).toContain('allow-downloads');
    expect(preview.body.toString()).toContain('name,value');
    const download = await get(csv.artifact.downloadUrl);
    expect(download.headers['content-disposition']).toContain('attachment');
    await expect(service.open(csv.artifact.id)).resolves.toMatchObject({ ok: true, artifact: { name: 'report.csv' } });
    await expect(service.create({ name: 'legacy.txt', contentBase64: 'bGVnYWN5' })).rejects.toThrow(/content must be a non-empty UTF-8/);
  });

  test('keeps artifacts across restarts and deletes them on request', async () => {
    const created = await service.create({ name: 'private.txt', content: 'private' });
    await service.stop();
    await expect(fs.access(path.join(userData, 'opencode-artifacts'))).resolves.toBeUndefined();

    service = new ArtifactService({
      app: { getPath: jest.fn(() => userData) },
      requestBrowserTool: jest.fn().mockResolvedValue({ ok: true }),
      logger: { warn: jest.fn() }
    });
    await service.start();
    await expect(service.tool({ tool: 'list_artifacts' })).resolves.toMatchObject({ artifacts: [{ id: created.artifact.id, name: 'private.txt' }], storage: { usedBytes: 7, limitBytes: 1_000_000_000, atLimit: false } });

    await expect(service.remove(created.artifact.id)).resolves.toMatchObject({ ok: true });
    await expect(fs.access(path.join(userData, 'opencode-artifacts', created.artifact.id))).rejects.toThrow();
    await expect(service.tool({ tool: 'list_artifacts' })).resolves.toMatchObject({ artifacts: [] });
  });
});
