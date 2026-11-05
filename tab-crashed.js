const sendToHost = (channel) => {
  if (window.electronAPI && typeof window.electronAPI.sendToHost === 'function') {
    window.electronAPI.sendToHost(channel);
  }
};

document.getElementById('reload-page')?.addEventListener('click', () => sendToHost('recover-crashed-tab'));
document.getElementById('close-tab')?.addEventListener('click', () => sendToHost('close-crashed-tab'));
