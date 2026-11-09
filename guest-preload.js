// Isolated link handling only. No Electron API is exposed to remote pages.
const { ipcRenderer } = require('electron');

  const getAnchorFromEvent = (event) => {
    const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const pathAnchor = eventPath.find((node) => node && node.tagName === 'A' && node.href);

    if (pathAnchor) {
      return pathAnchor;
    }

    return event.target && typeof event.target.closest === 'function'
      ? event.target.closest('a[href]')
      : null;
  };

  document.addEventListener('click', (event) => {
    // Ctrl-click is requested; Cmd-click supplies the same expected new-tab
    // behaviour on macOS. Only primary-button link activation is intercepted.
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    const anchor = getAnchorFromEvent(event);
    const url = anchor && anchor.href;
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) return;
    } catch { return; }

    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost('open-in-new-tab', { url, timestamp: Date.now() });
  }, true);

// Reading-mode notifications stay in the isolated preload, rather than giving
// website scripts a generic IPC sender.
let lastScrollY = window.scrollY;
let scrollTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const current = window.scrollY;
    if (current > lastScrollY + 10) ipcRenderer.sendToHost('webview-scrolled-down');
    lastScrollY = current;
  }, 100);
}, {passive: true});
document.addEventListener('click', event => {
  if (event.isTrusted) ipcRenderer.sendToHost('webview-clicked');
}, true);
