const { EventEmitter } = require('node:events');
const { verify } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_URL = 'https://cookthisapp.com/api/updates/orbit-internet-browser-3454d89a/latest.json';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAen44v3hocEA4N/7kmB9jdkLuWbOJNNawgrtRYq5EINU=
-----END PUBLIC KEY-----`;
const HOUR = 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

// Orbit uses vMAJOR.MINOR.PATCH; also understand standard prerelease/build suffixes.
function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') || [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function verifiedManifest(bytes, signature, publicKey = PUBLIC_KEY) {
  // Decode nothing from the body until authenticity of the exact bytes is established.
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || typeof signature !== 'string'
      || !/^[A-Za-z0-9+/_-]{86}(?:==)?$/.test(signature)) throw new Error('Invalid update signature');
  const decoded = Buffer.from(signature, 'base64');
  if (decoded.length !== 64 || !verify(null, bytes, publicKey, decoded)) throw new Error('Invalid update signature');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!parseVersion(manifest.version) || typeof manifest.download_url !== 'string'
      || manifest.download_url.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(manifest.download_url)) throw new Error('Invalid update manifest');
  const url = new URL(manifest.download_url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid update download URL');
  return { version: manifest.version, downloadUrl: url.href };
}

async function readBody(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Update manifest too large');
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Update manifest too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

class UpdateService extends EventEmitter {
  constructor({ currentVersion, statePath, fetchImpl = globalThis.fetch, now = Date.now, publicKey = PUBLIC_KEY }) {
    super();
    this.currentVersion = currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`;
    if (!parseVersion(this.currentVersion)) throw new Error('Invalid current version');
    Object.assign(this, { statePath, fetchImpl, now, publicKey });
    this.saved = { lastAttempt: null, dismissed: [], cached: null };
    this.update = null;
    this.inFlight = null;
    this.timer = null;
    this.stopped = true;
    try {
      if (statePath && fs.statSync(statePath).size <= 256 * 1024) {
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        this.saved.lastAttempt = Number.isFinite(saved.lastAttempt) ? saved.lastAttempt : null;
        this.saved.dismissed = Array.isArray(saved.dismissed) ? saved.dismissed.filter(v => typeof v === 'string').slice(-32) : [];
        if (saved.cached) {
          const bytes = Buffer.from(saved.cached.body, 'base64');
          const manifest = verifiedManifest(bytes, saved.cached.signature, this.publicKey);
          this.saved.cached = saved.cached;
          this.accept(manifest);
        }
      }
    } catch { /* Missing, corrupt or untrusted local state must never block startup. */ }
  }

  accept(manifest) {
    this.update = compareVersions(manifest.version, this.currentVersion) > 0
      && !this.saved.dismissed.includes(manifest.version) ? manifest : null;
  }

  getState() { return { currentVersion: this.currentVersion, update: this.update && { ...this.update } }; }

  persist() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
      fs.renameSync(`${this.statePath}.tmp`, this.statePath);
    } catch { /* Checking remains throttled in memory if local storage is unavailable. */ }
  }

  dismiss() {
    if (this.update) {
      this.saved.dismissed = [...this.saved.dismissed, this.update.version].slice(-32);
      this.update = null;
      this.persist();
      this.emit('change', this.getState());
    }
    return this.getState();
  }

  check() {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.saved.lastAttempt !== null && now - this.saved.lastAttempt < HOUR) return Promise.resolve(this.getState());
    this.saved.lastAttempt = now;
    this.saved.cached = null;
    this.update = null;
    this.persist(); // Persist before requesting, including failed attempts and restarts.
    this.inFlight = (async () => {
      try {
        const response = await this.fetchImpl(CHECK_URL, {
          signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' }
        });
        if (response.status !== 200) { await response.body?.cancel(); throw new Error('Update unavailable'); }
        const bytes = await readBody(response);
        const signature = response.headers.get('x-update-signature');
        const manifest = verifiedManifest(bytes, signature, this.publicKey);
        this.saved.cached = { body: bytes.toString('base64'), signature };
        this.accept(manifest);
      } catch { this.update = null; }
      this.persist();
      this.emit('change', this.getState());
      return this.getState();
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async start() {
    this.stopped = false;
    await this.check();
    if (this.stopped) return;
    const delay = Math.max(1, Math.min(HOUR, HOUR - (this.now() - this.saved.lastAttempt)));
    this.timer = setTimeout(() => { void this.start(); }, delay);
    this.timer.unref?.();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

module.exports = { UpdateService, compareVersions, verifiedManifest, CHECK_URL, PUBLIC_KEY, HOUR };
