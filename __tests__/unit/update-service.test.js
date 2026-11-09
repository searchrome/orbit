jest.unmock('fs');
jest.unmock('path');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReadableStream } = require('node:stream/web');
const { UpdateService, compareVersions, verifiedManifest, HOUR, CHECK_URL, PUBLIC_KEY } = require('../../update-service');
const keys = crypto.generateKeyPairSync('ed25519');
const otherKeys = crypto.generateKeyPairSync('ed25519');
const download = 'https://cookthisapp.com/apps/orbit/download';

function response(version = 'v1.0.3', options = {}) {
  const bytes = options.bytes || Buffer.from(JSON.stringify({ version, download_url: options.url || download }));
  const signature = options.signature ?? crypto.sign(null, bytes, options.key || keys.privateKey).toString('base64');
  return {
    status: options.status || 200,
    headers: { get: name => name === 'x-update-signature' ? signature : null },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })
  };
}

describe('Signed CookThisApp updates', () => {
  let directory, statePath, now, fetchImpl;
  let originalTimeout;
  const make = () => new UpdateService({ currentVersion: '1.0.2', statePath, fetchImpl, now: () => now, publicKey: keys.publicKey });
  beforeAll(() => {
    originalTimeout = AbortSignal.timeout;
    // jsdom lacks the native Node timeout factory. Fetch is mocked in these tests.
    AbortSignal.timeout = jest.fn(() => new AbortController().signal);
  });
  afterAll(() => { AbortSignal.timeout = originalTimeout; });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-update-test-'));
    statePath = path.join(directory, 'state.json');
    now = 1800000000000;
    fetchImpl = jest.fn(async () => response());
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test.each([
    ['v1.0.3', true], ['v1.0.10', true], ['v2.0.0', true],
    ['v1.0.2', false], ['1.0.2', false], ['v1.0.1', false], ['v1.0.2-beta.1', false]
  ])('shows only newer versions: %s', async (version, visible) => {
    fetchImpl.mockImplementation(async () => response(version));
    const state = await make().check();
    expect(Boolean(state.update)).toBe(visible);
    expect(state.currentVersion).toBe('v1.0.2');
    if (visible) expect(state.update).toEqual({ version, downloadUrl: download });
  });

  test.each([
    ['missing signature', () => response(undefined, { signature: '' })],
    ['wrong signing key', () => response(undefined, { key: otherKeys.privateKey })],
    ['tampered body', () => {
      const signature = crypto.sign(null, Buffer.from('{"version":"v1.0.3"}'), keys.privateKey).toString('base64');
      return response(undefined, { signature });
    }],
    ['malformed JSON', () => response(undefined, { bytes: Buffer.from('{') })],
    ['invalid version', () => response('latest')],
    ['404', () => response(undefined, { status: 404 })],
    ['network error', () => { throw new Error('Offline'); }],
    ['timeout', () => { throw new DOMException('Timeout', 'TimeoutError'); }],
    ['oversized body', () => response(undefined, { bytes: Buffer.alloc(65537) })]
  ])('%s quietly produces no notice and throttles retries', async (_name, result) => {
    fetchImpl.mockImplementation(async () => result());
    const service = make();
    await expect(service.check()).resolves.toMatchObject({ update: null });
    await service.check();
    await make().check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each(['file:///tmp/app', 'javascript:alert(1)', 'data:text/html,hi', 'http://example.com/app', 'https://user:password@example.com/app'])(
    'rejects unsafe download destinations even when signed: %s', async url => {
      fetchImpl.mockImplementation(async () => response(undefined, { url }));
      expect((await make().check()).update).toBeNull();
    }
  );

  test('verifies exact bytes before attempting JSON parsing', () => {
    const bytes = Buffer.from('invalid JSON\n');
    const signature = crypto.sign(null, bytes, keys.privateKey).toString('base64');
    expect(() => verifiedManifest(bytes, signature, keys.publicKey)).toThrow(SyntaxError);
    expect(() => verifiedManifest(Buffer.from('invalid JSON'), signature, keys.publicKey)).toThrow('Invalid update signature');
    expect(() => verifiedManifest(bytes, signature)).toThrow('Invalid update signature');
    expect(crypto.createPublicKey(PUBLIC_KEY).asymmetricKeyType).toBe('ed25519');
  });

  test('deduplicates concurrent requests and checks again only after one hour', async () => {
    const service = make();
    await Promise.all([service.check(), service.check(), service.check()]);
    now += HOUR - 1;
    await service.check();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now++;
    await service.check();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(CHECK_URL, expect.objectContaining({ redirect: 'error', signal: expect.anything() }));
  });

  test('reuses authenticated cache across restarts and remembers dismissal', async () => {
    const service = make();
    await service.check();
    const restarted = make();
    expect((await restarted.check()).update.version).toBe('v1.0.3');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(restarted.dismiss().update).toBeNull();
    expect(make().getState().update).toBeNull();
    now += HOUR;
    fetchImpl.mockImplementation(async () => response('v1.0.4'));
    expect((await make().check()).update.version).toBe('v1.0.4');
  });

  test('never trusts cached JSON without reverifying its signature', async () => {
    await make().check();
    const saved = JSON.parse(fs.readFileSync(statePath));
    saved.cached.body = Buffer.from(JSON.stringify({ version: 'v99.0.0', download_url: download })).toString('base64');
    fs.writeFileSync(statePath, JSON.stringify(saved));
    expect((await make().check()).update).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('hides an earlier notice when the next check fails', async () => {
    const service = make();
    await service.check();
    now += HOUR;
    fetchImpl.mockRejectedValue(new Error('Offline'));
    expect((await service.check()).update).toBeNull();
    expect(make().getState().update).toBeNull();
  });

  test('schedules checks without polling more frequently than hourly', async () => {
    jest.useFakeTimers();
    const service = make();
    try {
      await service.start();
      now += HOUR - 1;
      await jest.advanceTimersByTimeAsync(HOUR - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      now++;
      await jest.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      service.stop();
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { service.stop(); jest.useRealTimers(); }
  });

  test.each([
    ['v1.0.10', 'v1.0.2', 1], ['v1.0.2+build', '1.0.2', 0],
    ['v1.0.2-beta.10', 'v1.0.2-beta.2', 1], ['v1.0.2', 'v1.0.2-rc.1', 1],
    ['v1.0.1', 'v1.0.2', -1], ['v1.0.2-alpha', 'v1.0.2-alpha.1', -1]
  ])('compares versions numerically: %s vs %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
