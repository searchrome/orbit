const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 250;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 250 * 1024 * 1024;

function safeFileName(value) {
    const name = path.basename(String(value || '')).replace(/[\0/\\]/g, '_').trim();
    if (!name || name === '.' || name === '..') throw new Error('The selected file has no safe filename.');
    return name.slice(0, 180);
}

async function uniqueDestination(directory, preferredName) {
    const extension = path.extname(preferredName);
    const stem = path.basename(preferredName, extension);
    for (let index = 0; index < 10_000; index += 1) {
        const candidate = index === 0 ? preferredName : `${stem} (${index})${extension}`;
        try {
            await fs.promises.access(path.join(directory, candidate));
        } catch (error) {
            if (error?.code === 'ENOENT') return candidate;
            throw error;
        }
    }
    throw new Error('Too many files with the same name in this session.');
}

class OpenCodeSessionWorkspace {
    constructor({ app }) {
        this.app = app;
    }

    get directory() {
        return path.join(this.app.getPath('userData'), 'opencode-sessions');
    }

    async create() {
        const id = crypto.randomUUID();
        const root = path.join(this.directory, id);
        const inputDirectory = path.join(root, 'inputs');
        await fs.promises.mkdir(inputDirectory, { recursive: true, mode: 0o700 });
        return { id, root, inputDirectory, startedAt: Date.now() };
    }

    async list(session) {
        if (!session?.inputDirectory) throw new Error('Start a new OpenCode session before uploading files.');
        const entries = await fs.promises.readdir(session.inputDirectory, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const filePath = path.join(session.inputDirectory, entry.name);
            const details = await fs.promises.stat(filePath);
            files.push({ name: entry.name, size: details.size, uploadedAt: details.mtime.toISOString() });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        const usedBytes = files.reduce((total, file) => total + file.size, 0);
        return {
            sessionId: session.id,
            files,
            storage: { usedBytes, maxBytes: MAX_TOTAL_BYTES, atLimit: usedBytes >= MAX_TOTAL_BYTES || files.length >= MAX_FILES }
        };
    }

    async upload(session, sourcePaths) {
        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return this.list(session);
        const existing = await this.list(session);
        if (existing.files.length + sourcePaths.length > MAX_FILES) {
            throw new Error(`A session can contain at most ${MAX_FILES} uploaded files.`);
        }

        let projectedBytes = existing.storage.usedBytes;
        const checked = [];
        for (const sourcePath of sourcePaths) {
            const details = await fs.promises.stat(sourcePath);
            if (!details.isFile()) throw new Error('Only regular files can be uploaded to an OpenCode session.');
            if (details.size > MAX_FILE_BYTES) throw new Error('Each uploaded file must be 250 MB or smaller.');
            projectedBytes += details.size;
            checked.push({ sourcePath, name: safeFileName(sourcePath) });
        }
        if (projectedBytes > MAX_TOTAL_BYTES) {
            throw new Error('This upload would exceed the 1 GB session input limit.');
        }

        for (const file of checked) {
            const destinationName = await uniqueDestination(session.inputDirectory, file.name);
            await fs.promises.copyFile(file.sourcePath, path.join(session.inputDirectory, destinationName));
        }
        return this.list(session);
    }
}

module.exports = OpenCodeSessionWorkspace;
