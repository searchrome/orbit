const fs = require('node:fs');
const path = require('node:path');

describe('Update notices in the main window and Settings', () => {
  let notices, api, receive;
  const update = { version: 'v1.0.3', downloadUrl: 'https://cookthisapp.com/download' };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    notices = [...document.querySelectorAll('[data-update-notice]')];
    api = window.electronAPI = {
      invoke: jest.fn().mockResolvedValue({ update }),
      on: jest.fn((_channel, listener) => { receive = listener; })
    };
    const source = fs.readFileSync(path.join(__dirname, '../../update-notice.js'), 'utf8');
    const Notice = new Function(source.replace('export default class', 'return class'))();
    new Notice();
  });

  test('renders the same dismissible notice in both locations without opening the download', async () => {
    await flush();
    expect(notices).toHaveLength(2);
    expect(notices[1].closest('#settings-panel')).not.toBeNull();
    for (const notice of notices) {
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain('A newer version is available');
      expect(notice.querySelector('a').href).toBe(update.downloadUrl);
    }
    expect(api.invoke.mock.calls).toEqual([['updates-get-state']]);
  });

  test('opens the verified download only on explicit link click', async () => {
    await flush();
    notices[0].querySelector('a').click();
    expect(api.invoke).toHaveBeenLastCalledWith('updates-open-download');
  });

  test('dismisses both notices and updates both when a later version arrives', async () => {
    await flush();
    api.invoke.mockResolvedValue({ update: null });
    notices[1].querySelector('button').click();
    await flush();
    expect(api.invoke).toHaveBeenLastCalledWith('updates-dismiss');
    expect(notices.every(n => n.hidden)).toBe(true);
    receive({ update: { ...update, version: 'v1.0.4' } });
    expect(notices.every(n => !n.hidden)).toBe(true);
    expect(notices[0].textContent).toContain('v1.0.4');
  });

  test('leaves notices hidden on no update or an unsafe URL', () => {
    receive({ update: null });
    expect(notices.every(n => n.hidden)).toBe(true);
    receive({ update: { ...update, downloadUrl: 'javascript:alert(1)' } });
    expect(notices.every(n => n.hidden)).toBe(true);
    expect(notices[0].querySelector('a').hasAttribute('href')).toBe(false);
  });
});
