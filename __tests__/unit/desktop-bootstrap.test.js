const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bootstrap = require('../../desktop-bootstrap');

describe('standalone desktop startup', () => {
  let temporary;
  beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-startup-')); });
  afterEach(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
  const makeApp = packaged => ({ isPackaged: packaged,
    getPath: key => key === 'appData' ? temporary : path.join(temporary, 'development-profile'),
    setPath: jest.fn(), setName: jest.fn() });
  test('uses the existing browser profile when packaged with the Orbit name', () => {
    const app = makeApp(true);
    expect(bootstrap(app, {})).toBe(path.join(temporary, 'browser'));
    expect(app.setPath).toHaveBeenCalledWith('userData', path.join(temporary, 'browser'));
    expect(app.setName).toHaveBeenCalledWith('browser');
  });
  test('keeps runtime settings outside the bundle and respects environment overrides', () => {
    fs.writeFileSync(path.join(temporary, 'runtime.env'), 'LLM="claude"\nOPENROUTER_MODEL=example\n');
    const env = { ORBIT_USER_DATA_DIR: temporary, LLM: 'codex' };
    bootstrap(makeApp(true), env);
    expect(env.LLM).toBe('codex');
    expect(env.OPENROUTER_MODEL).toBe('example');
    expect(env.PATH.split(path.delimiter)).toContain('/opt/homebrew/bin');
  });
  test('preserves a development or test profile', () => {
    expect(bootstrap(makeApp(false), {})).toBe(path.join(temporary, 'development-profile'));
  });
});
