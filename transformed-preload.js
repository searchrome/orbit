// Used only for the bundled transformed-view page.
const { contextBridge, ipcRenderer } = require('electron');
const expected = (process.argv || []).find(arg => arg.startsWith('--browser-guest-page-url='))?.slice('--browser-guest-page-url='.length);
const page = new URL(window.location.href);
page.search = ''; page.hash = '';
const trustedPage = process.isMainFrame === true && page.protocol === 'file:' && page.href === expected;
if (trustedPage) {
contextBridge.exposeInMainWorld('transformedViewAPI', {
  send(channel) {
    if (['transformed-view-ready', 'transformed-view-refresh', 'transformed-view-open-original'].includes(channel)) ipcRenderer.sendToHost(channel);
  },
  onData(listener) {
    if (typeof listener === 'function') ipcRenderer.on('transformed-view-data', (_event, payload) => listener(payload));
  }
});
}
