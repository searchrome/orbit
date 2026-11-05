jest.unmock('fs');
jest.unmock('path');

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const OpenCodeSessionWorkspace = require('../../opencode-session-workspace');

describe('OpenCodeSessionWorkspace', () => {
    let userData;
    let sourceDirectory;

    beforeEach(async () => {
        userData = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-session-user-data-'));
        sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-session-source-'));
    });

    afterEach(async () => {
        await fs.rm(userData, { recursive: true, force: true });
        await fs.rm(sourceDirectory, { recursive: true, force: true });
    });

    test('copies user-selected inputs into an isolated new session folder', async () => {
        const source = path.join(sourceDirectory, 'sites.csv');
        await fs.writeFile(source, 'url\nhttps://example.test\n');
        const workspaces = new OpenCodeSessionWorkspace({ app: { getPath: () => userData } });
        const session = await workspaces.create();

        const uploaded = await workspaces.upload(session, [source]);

        expect(session.inputDirectory).toContain(`${path.sep}opencode-sessions${path.sep}${session.id}${path.sep}inputs`);
        expect(uploaded.files).toEqual([expect.objectContaining({ name: 'sites.csv', size: 25 })]);
        await expect(fs.readFile(path.join(session.inputDirectory, 'sites.csv'), 'utf8')).resolves.toBe('url\nhttps://example.test\n');
    });

    test('keeps same-named uploads instead of overwriting an earlier input', async () => {
        const source = path.join(sourceDirectory, 'people.csv');
        await fs.writeFile(source, 'first');
        const workspaces = new OpenCodeSessionWorkspace({ app: { getPath: () => userData } });
        const session = await workspaces.create();
        await workspaces.upload(session, [source]);
        await fs.writeFile(source, 'second');

        const uploaded = await workspaces.upload(session, [source]);

        expect(uploaded.files.map((file) => file.name)).toEqual(['people (1).csv', 'people.csv']);
        await expect(fs.readFile(path.join(session.inputDirectory, 'people.csv'), 'utf8')).resolves.toBe('first');
        await expect(fs.readFile(path.join(session.inputDirectory, 'people (1).csv'), 'utf8')).resolves.toBe('second');
    });
});
