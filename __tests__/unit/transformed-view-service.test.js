jest.unmock('fs');

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const TransformedViewService = require('../../transformed-view-service.js');

describe('TransformedViewService', () => {
    let userData;

    beforeEach(async () => {
        userData = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-transformed-view-'));
    });

    afterEach(async () => {
        await fs.rm(userData, { recursive: true, force: true });
    });

    function service() {
        return new TransformedViewService({
            app: { getPath: jest.fn(() => userData) },
            logger: { warn: jest.fn() }
        });
    }

    test('persists a reusable selector recipe and its latest source refresh', async () => {
        const first = service();
        const created = await first.create({
            name: 'Readable release notes',
            sourceUrl: 'https://example.test/releases',
            recipe: {
                rootSelector: 'article',
                titleSelector: 'h1',
                removeSelectors: ['.advertisement'],
                theme: 'dark'
            }
        });

        await first.recordSuccess(created.id, 'https://example.test/releases?current=1');

        const reloaded = await service().get(created.id);
        expect(reloaded).toEqual(expect.objectContaining({
            id: created.id,
            name: 'Readable release notes',
            sourceUrl: 'https://example.test/releases',
            recipe: expect.objectContaining({
                rootSelector: 'article',
                removeSelectors: ['.advertisement'],
                theme: 'dark'
            }),
            lastSourceUrl: 'https://example.test/releases?current=1'
        }));
        expect(reloaded.lastSuccessAt).toEqual(expect.any(String));
    });

    test('rejects a stale recipe update without overwriting the saved view', async () => {
        const views = service();
        const created = await views.create({
            name: 'Documentation reader',
            sourceUrl: 'https://example.test/docs',
            recipe: {}
        });
        const updated = await views.update({
            id: created.id,
            expectedRevision: created.revision,
            name: 'Documentation reader v2'
        });

        await expect(views.update({
            id: created.id,
            expectedRevision: created.revision,
            name: 'Stale edit'
        })).rejects.toThrow('changed');

        expect((await views.get(created.id)).name).toBe('Documentation reader v2');
        expect(updated.revision).toBe(created.revision + 1);
    });
});
