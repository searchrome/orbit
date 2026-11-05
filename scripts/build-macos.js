#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');

async function build() {
  if (process.platform !== 'darwin') throw new Error('Build the macOS app on a Mac.');
  const root = path.resolve(__dirname, '..');
  const scratch = path.join(root, '.tmp', 'mac-build');
  const iconset = path.join(scratch, 'orbit.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const icon = path.join(root, 'icons', 'orbit.icns');
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale),
        path.join(root, 'icons', 'orbit.png'), '--out',
        path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  // Package the installed Electron runtime, avoiding a second download or version change.
  const electronRoot = path.dirname(require.resolve('electron/package.json'));
  const version = require(path.join(electronRoot, 'package.json')).version;
  const runtime = path.join(electronRoot, 'dist');
  if (fs.readFileSync(path.join(runtime, 'version'), 'utf8').trim().replace(/^v/, '') !== version) {
    throw new Error('Installed Electron runtime does not match its package version.');
  }
  const runtimeZipDirectory = path.join(scratch, 'runtime-plain');
  fs.mkdirSync(runtimeZipDirectory, { recursive: true });
  const zip = path.join(runtimeZipDirectory, `electron-v${version}-darwin-${process.arch}.zip`);
  if (!fs.existsSync(zip)) {
    console.log('Preparing the installed Electron runtime…');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', runtime, zip]);
  }
  console.log('Building Orbit.app…');
  const outputs = await packager({
    dir: root, name: 'Orbit', platform: 'darwin', arch: process.arch,
    appBundleId: 'com.orbit.browser', appCategoryType: 'public.app-category.productivity',
    icon, electronVersion: version, electronZipDir: runtimeZipDirectory,
    out: process.env.ORBIT_BUILD_OUT || path.join(root, 'dist'), overwrite: true, asar: false, prune: true,
    ignore: [/^\/(?:\.git|\.tmp|\.playwright-cli|\.claude|\.codex|\.agents|\.aws|output|coverage|docs|dist|__tests__|__mocks__|linkedin)(?:\/|$)/,
      /^\/\.env(?:\..*)?$/, /^\/(?:ACTIVE_TASK|CLAUDE|udpae)\.md$/]
  });
  for (const output of outputs) {
    const appPath = path.join(output, 'Orbit.app');
    // Ad-hoc signing supports running this local build; distribution signing is separate.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`Built: ${appPath}`);
  }
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
