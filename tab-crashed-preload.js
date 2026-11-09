// Used only for the bundled crash recovery page.
const { contextBridge, ipcRenderer } = require('electron');
const expected = (process.argv || []).find(arg => arg.startsWith('--browser-guest-page-url='))?.slice('--browser-guest-page-url='.length);
const page = new URL(window.location.href);
page.search = ''; page.hash = '';
const trustedPage = process.isMainFrame === true && page.protocol === 'file:' && page.href === expected;
if (trustedPage) {
contextBridge.exposeInMainWorld('crashedTabAPI', {
  recover: () => ipcRenderer.sendToHost('recover-crashed-tab'),
  close: () => ipcRenderer.sendToHost('close-crashed-tab')
});
}
