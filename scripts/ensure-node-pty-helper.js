#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
    process.exit(0);
}

try {
    const packagePath = require.resolve('node-pty/package.json');
    const helperPath = path.join(path.dirname(packagePath), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (!fs.existsSync(helperPath)) {
        process.exit(0);
    }
    const mode = fs.statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o755);
        process.stdout.write(`Enabled node-pty spawn helper: ${helperPath}\n`);
    }
} catch (error) {
    process.stderr.write(`Could not prepare node-pty spawn helper: ${error?.message || error}\n`);
    process.exit(1);
}
