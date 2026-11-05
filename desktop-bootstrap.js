// Finder launches have no project argument or login-shell environment.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function bootstrapDesktop(app, environment = process.env) {
  // Keep the profile used by the development browser when the bundle is named Orbit.
  const profile = environment.ORBIT_USER_DATA_DIR || (app.isPackaged
    ? path.join(app.getPath('appData'), 'browser')
    : app.getPath('userData'));
  app.setPath('userData', profile);
  // Preserve the existing internal identity for stored credentials; macOS uses
  // the bundle's Orbit display name and icon for Finder and the Dock.
  app.setName('browser');
  const settingsFile = path.join(profile, 'runtime.env');
  if (fs.existsSync(settingsFile)) {
    for (const raw of fs.readFileSync(settingsFile, 'utf8').split(/\r?\n/)) {
      const match = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || environment[match[1]] !== undefined) continue;
      environment[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  if (app.isPackaged) {
    const home = os.homedir();
    const nodeVersions = path.join(home, '.nvm', 'versions', 'node');
    const nodeBins = fs.existsSync(nodeVersions)
      ? fs.readdirSync(nodeVersions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(nodeVersions, version, 'bin'))
      : [];
    environment.PATH = [...new Set([
      ...(environment.PATH || '').split(path.delimiter).filter(Boolean),
      path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...nodeBins,
      '/usr/bin', '/bin', '/usr/sbin', '/sbin'
    ])].join(path.delimiter);
  }
  return profile;
};
