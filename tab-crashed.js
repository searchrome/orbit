document.getElementById('reload-page')?.addEventListener('click', () => window.crashedTabAPI?.recover());
document.getElementById('close-tab')?.addEventListener('click', () => window.crashedTabAPI?.close());
