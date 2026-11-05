const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPreload({ pathname, argv = [] } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8');
    const ipcRenderer = {
        send: jest.fn(),
        sendToHost: jest.fn(),
        on: jest.fn(),
        invoke: jest.fn().mockResolvedValue('planner-result')
    };
    const document = {
        createElement: jest.fn(() => ({ textContent: '' })),
        addEventListener: jest.fn(),
        head: {
            appendChild: jest.fn()
        }
    };
    const window = {
        location: {
            pathname
        },
        addEventListener: jest.fn(),
        document
    };
    const electronMock = {
        contextBridge: {
            exposeInMainWorld: jest.fn((name, api) => {
                window[name] = api;
            })
        },
        ipcRenderer
    };
    const sandbox = {
        window,
        document,
        process: {
            argv
        },
        console: {
            log: jest.fn(),
            error: jest.fn()
        },
        require: (specifier) => {
            if (specifier === 'electron') {
                return electronMock;
            }

            throw new Error(`Unexpected require: ${specifier}`);
        }
    };

    sandbox.global = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'preload.js' });

    return {
        window,
        document,
        ipcRenderer
    };
}

describe('preload planner gating', () => {
    test('allows the host browser renderer to invoke the assistant planner', async () => {
        const { window, ipcRenderer } = loadPreload({
            pathname: '/Users/sozay/workspace/browser/index.html'
        });

        await expect(window.electronAPI.invoke('assistant-next-action', { prompt: 'used bike' }))
            .resolves.toBe('planner-result');

        expect(ipcRenderer.invoke).toHaveBeenCalledWith('assistant-next-action', { prompt: 'used bike' });
    });

    test('allows only the host browser renderer to inspect media frames for casting', async () => {
        const host = loadPreload({ pathname: '/Users/sozay/workspace/browser/index.html' });
        await expect(host.window.electronAPI.invoke('cast-extract-video', { webContentsId: 42 }))
            .resolves.toBe('planner-result');
        expect(host.ipcRenderer.invoke).toHaveBeenCalledWith('cast-extract-video', { webContentsId: 42 });

        await expect(host.window.electronAPI.invoke('cast-relay-video', { webContentsId: 42 }))
            .resolves.toBe('planner-result');
        expect(host.ipcRenderer.invoke).toHaveBeenCalledWith('cast-relay-video', { webContentsId: 42 });

        const guest = loadPreload({ pathname: '/Users/sozay/workspace/browser/assistant.html' });
        await expect(guest.window.electronAPI.invoke('cast-extract-video', { webContentsId: 42 }))
            .rejects.toThrow('cast-extract-video is restricted to the host browser window.');
        await expect(guest.window.electronAPI.invoke('cast-relay-video', { webContentsId: 42 }))
            .rejects.toThrow('cast-relay-video is restricted to the host browser window.');
        expect(guest.ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    test('rejects assistant planner calls from a guest renderer', async () => {
        const { window, document, ipcRenderer } = loadPreload({
            pathname: '/Users/sozay/workspace/browser/assistant.html'
        });

        await expect(window.electronAPI.invoke('assistant-next-action', { prompt: 'used bike' }))
            .rejects.toThrow('assistant-next-action is restricted to the host browser window.');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();

        const clickHandler = document.addEventListener.mock.calls
            .find(([eventName]) => eventName === 'click')[1];
        const anchor = { tagName: 'A', href: 'https://example.com/report' };
        const preventDefault = jest.fn();
        const stopImmediatePropagation = jest.fn();
        clickHandler({
            button: 0,
            ctrlKey: true,
            metaKey: false,
            defaultPrevented: false,
            composedPath: () => [{ tagName: 'SPAN' }, anchor],
            target: { closest: jest.fn() },
            preventDefault,
            stopImmediatePropagation
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
            'open-in-new-tab',
            expect.objectContaining({ url: 'https://example.com/report' })
        );
    });

    test('does not install a guest link listener in the host browser renderer', () => {
        const { document } = loadPreload({
            pathname: '/Users/sozay/workspace/browser/index.html'
        });

        expect(document.addEventListener).not.toHaveBeenCalledWith('click', expect.any(Function), true);
    });
});
