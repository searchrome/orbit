jest.unmock('fs');
jest.unmock('path');

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const OpenCodeService = require('../../opencode-service');

describe('OpenCodeService browser agent configuration', () => {
  let userDataPath;

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-service-test-'));
  });

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  function createService(overrides = {}) {
    return new OpenCodeService({
      app: { getPath: jest.fn(() => userDataPath) },
      getBrowserRemoteConnection: jest.fn(),
      cancelBrowserActions: jest.fn(),
      emitOutput: jest.fn(),
      emitStatus: jest.fn(),
      logger: { warn: jest.fn() },
      ...overrides
    });
  }

  function createSecretStorage() {
    return {
      isEncryptionAvailable: jest.fn(() => true),
      encryptString: jest.fn((value) => Buffer.from(`encrypted:${value}`, 'utf8')),
      decryptString: jest.fn((value) => value.toString('utf8').replace(/^encrypted:/, ''))
    };
  }

  test('denies inherited tools and permits only explicit browser actions', async () => {
    const service = createService();
    expect(service.defaultSettings.model).toBe('opencode-go/glm-5.3-flash');
    const remoteConnection = {
      url: 'http://127.0.0.1:12345/tool',
      token: 'test-token'
    };
    const artifactConnection = {
      url: 'http://127.0.0.1:54321/tool',
      token: 'artifact-test-token'
    };
    const { configPath } = await service.writeRuntimeConfig(remoteConnection, artifactConnection);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const permissions = config.agent.browser.permission;

    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config.provider.openrouter.options.apiKey).toBe('{env:OPENROUTER_API_KEY}');
    expect(config.mcp.browser.environment).toMatchObject({
      BROWSER_REMOTE_URL: remoteConnection.url,
      BROWSER_REMOTE_TOKEN: remoteConnection.token,
      ARTIFACT_REMOTE_URL: artifactConnection.url,
      ARTIFACT_REMOTE_TOKEN: artifactConnection.token
    });
    expect(config.agent.browser.prompt).toContain('create_artifact');
    expect(config.agent.browser.prompt).toContain('Do not claim that you cannot create a file or report');
    expect(config.agent.browser.prompt).toContain('never base64-encode content');
    expect(config.agent.browser.prompt).toContain('User-uploaded task inputs');
    expect(config.agent.browser.prompt).toContain('web artifactory');
    expect(config.agent.browser.prompt).toContain('web atifactory');
    expect(config.agent.browser.prompt).toContain('contentType "text/html"');
    expect(config.agent.browser.prompt).toContain('BROWSER AGENT OPERATING GUIDE');
    expect(config.agent.browser.prompt).toContain('complete_task BEFORE your final answer');
    expect(config.agent.browser.prompt).toContain('REQUIRED BUILD WORKFLOW');
    expect(config.agent.browser.prompt).toContain('INTERACTION AND NAVIGATION BOUNDARY');
    expect(config.agent.browser.prompt).toContain('Open source buttons');
    expect(permissions['*']).toBe('deny');
    expect(permissions.read).toBe('allow');
    expect(permissions.browser_read_page_text).toBe('allow');
    expect(permissions.browser_find_page_text).toBe('allow');
    expect(permissions.browser_wait_for_element).toBe('allow');
    expect(permissions.browser_batch_read_tabs).toBe('allow');
    expect(permissions.browser_create_artifact).toBe('allow');
    expect(permissions.browser_get_dynamic_artifact_guide).toBe('allow');
    expect(permissions.browser_create_dynamic_artifact).toBe('allow');
    expect(permissions.browser_update_dynamic_artifact).toBe('allow');
    expect(permissions.browser_get_dynamic_artifact).toBe('allow');
    expect(permissions.browser_list_artifacts).toBe('allow');
    expect(permissions.browser_open_artifact).toBe('allow');
    expect(permissions.browser_download_artifact).toBe('ask');
    expect(permissions.browser_navigate_tab).toBe('allow');
    expect(permissions.browser_click_element).toBe('allow');
    expect(permissions.browser_type_into).toBe('allow');
    expect(permissions.browser_close_tab).toBe('allow');
    expect(permissions.browser_begin_task).toBe('allow');
    expect(permissions.browser_complete_task).toBe('allow');
    expect(permissions.bash).toBeUndefined();
  });

  test('migrates only the prior built-in model default', async () => {
    const service = createService();
    await fs.writeFile(service.settingsPath, JSON.stringify({ model: 'openai/gpt-5.4-mini' }));
    await expect(service.getSettings()).resolves.toMatchObject({ model: 'opencode-go/glm-5.3-flash' });

    await fs.writeFile(service.settingsPath, JSON.stringify({ model: 'z-ai/glm-5.3-flash' }));
    await expect(service.getSettings()).resolves.toMatchObject({ model: 'opencode-go/glm-5.3-flash' });

    await fs.writeFile(service.settingsPath, JSON.stringify({ model: 'openrouter/z-ai/glm-5.3-flash' }));
    await expect(service.getSettings()).resolves.toMatchObject({ model: 'opencode-go/glm-5.3-flash' });

    await fs.writeFile(service.settingsPath, JSON.stringify({ model: 'relace/fp4' }));
    await expect(service.getSettings()).resolves.toMatchObject({ model: 'relace/fp4' });

    await expect(service.saveSettings({ model: 'entrim/zai-org/GLM-5.3-Flash' })).resolves.toMatchObject({ model: 'entrim/zai-org/GLM-5.3-Flash' });
  });

  test('preserves a left terminal dock and bounds its width', async () => {
    const service = createService();
    await expect(service.saveSettings({ drawerWidth: 500, dock: 'left' })).resolves.toMatchObject({ drawerWidth: 500, dock: 'left' });
    await expect(service.getSettings()).resolves.toMatchObject({ drawerWidth: 500, dock: 'left' });
    await expect(service.saveSettings({ drawerWidth: 900, dock: 'elsewhere' })).resolves.toMatchObject({ drawerWidth: 720, dock: 'bottom' });
  });

  test('configures Entrim and passes only its encrypted saved key through the child environment', async () => {
    const service = createService({ secretStorage: createSecretStorage(), getBrowserRemoteConnection: jest.fn().mockResolvedValue({ url: 'http://127.0.0.1:12345/tool', token: 'test' }) });
    await service.saveSettings({ model: 'entrim/zai-org/GLM-5.3-Flash', entrimApiKey: 'entrim-test-secret' });
    expect(await fs.readFile(`${service.credentialsPath}.entrim`, 'utf8')).not.toContain('entrim-test-secret');
    const { configPath } = await service.writeRuntimeConfig({ url: 'http://127.0.0.1:12345/tool', token: 'test' });
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(config.provider.entrim.options).toEqual({ baseURL: 'https://api.entrim.ai/v1', apiKey: '{env:ENTRIM_API_KEY}' });
    expect(Object.keys(config.provider.entrim.models).sort()).toEqual(['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.3-Flash']);
    service.createTerminal = jest.fn(() => ({ pid: 99999999, onData: jest.fn(), onExit: jest.fn() }));
    await service.start({});
    expect(service.createTerminal).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--model', 'entrim/zai-org/GLM-5.3-Flash']), expect.objectContaining({ env: expect.objectContaining({ ENTRIM_API_KEY: 'entrim-test-secret' }) }));
    await service.saveSettings({ model: 'openrouter/z-ai/glm-5.3-flash' });
    expect((await service.getSettings()).model).toBe('openrouter/z-ai/glm-5.3-flash');
  });

  test('stores an OpenRouter key separately from terminal settings and exposes only its status', async () => {
    const secretStorage = createSecretStorage();
    const service = createService({ secretStorage });
    const apiKey = 'sk-or-v1-test-key';

    const saved = await service.saveSettings({ openRouterApiKey: apiKey });
    expect(saved).toMatchObject({ openRouterKeyConfigured: true, openRouterKeySource: 'saved' });
    expect(await fs.readFile(service.settingsPath, 'utf8')).not.toContain(apiKey);
    expect(await fs.readFile(service.credentialsPath, 'utf8')).not.toContain(apiKey);
    await expect(service.getOpenRouterCredential()).resolves.toEqual({ value: apiKey, source: 'saved' });

    await expect(service.saveSettings({ clearOpenRouterApiKey: true }))
      .resolves.toMatchObject({ openRouterKeyConfigured: false, openRouterKeySource: 'none' });
    await expect(fs.access(service.credentialsPath)).rejects.toThrow();
  });

  test('provides the saved OpenRouter key to a newly started OpenCode session', async () => {
    const secretStorage = createSecretStorage();
    const service = createService({
      secretStorage,
      getBrowserRemoteConnection: jest.fn().mockResolvedValue({ url: 'http://127.0.0.1:12345/tool', token: 'test-token' })
    });
    const apiKey = 'sk-or-v1-session-key';
    await service.saveSettings({ openRouterApiKey: apiKey });
    const child = {
      transport: 'test',
      pid: 99999999,
      onData: jest.fn(),
      onExit: jest.fn()
    };
    service.createTerminal = jest.fn(() => child);

    await service.start({ model: 'openrouter/test-model' });

    expect(service.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--model', 'openrouter/test-model']),
      expect.objectContaining({ env: expect.objectContaining({ OPENROUTER_API_KEY: apiKey }) })
    );
    expect(service.session.id).toEqual(expect.any(String));
    expect(service.session.workspace).toContain(`${path.sep}opencode-sessions${path.sep}`);
  });

  test('cancels browser work and resolves stop after the PTY exits', async () => {
    const cancelBrowserActions = jest.fn();
    const emitStatus = jest.fn();
    const service = createService({ cancelBrowserActions, emitStatus });
    let onExit;
    const child = {
      pid: 99999999,
      kill: jest.fn(),
      onExit: (listener) => { onExit = listener; }
    };
    service.process = child;
    service.session = { model: 'openai/test' };
    child.onExit((result) => service.handleProcessExit(child, result, 'openai/test'));

    const stopped = service.stop();
    expect(cancelBrowserActions).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    onExit({ exitCode: 0 });
    await expect(stopped).resolves.toMatchObject({ stopped: true, running: false });
    expect(emitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'stopped' }));
  });

  test('refuses an upload if the session changed while the file picker was open', async () => {
    const service = createService();
    service.session = { id: 'replacement-session', inputDirectory: path.join(userDataPath, 'replacement-inputs') };
    const upload = jest.spyOn(service.sessionWorkspace, 'upload');

    await expect(service.uploadFiles(['/tmp/task.csv'], { sessionId: 'picker-session' }))
      .rejects.toThrow('session changed while the file picker was open');
    expect(upload).not.toHaveBeenCalled();
  });
});
