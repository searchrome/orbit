export default class UpdateNotice {
  constructor() {
    this.notices = [...document.querySelectorAll('[data-update-notice]')];
    const api = window.electronAPI;
    if (!this.notices.length || !api?.invoke || !api?.on) return;
    for (const notice of this.notices) {
      notice.querySelector('[data-update-dismiss]').addEventListener('click', async () => {
        try { this.render(await api.invoke('updates-dismiss')); } catch { /* Remain usable offline. */ }
      });
      notice.querySelector('[data-update-download]').addEventListener('click', event => {
        event.preventDefault();
        // Only the main process opens the URL from the verified manifest.
        void api.invoke('updates-open-download').catch(() => {});
      });
    }
    api.on('updates-status', state => this.render(state));
    void api.invoke('updates-get-state').then(state => this.render(state)).catch(() => {});
  }

  render(state) {
    for (const label of document.querySelectorAll('[data-current-version]')) {
      if (typeof state?.currentVersion === 'string') label.textContent = state.currentVersion;
    }
    const update = state?.update;
    let url;
    try { url = new URL(update?.downloadUrl); } catch { /* No valid update. */ }
    const visible = typeof update?.version === 'string' && url?.protocol === 'https:' && !url.username && !url.password;
    for (const notice of this.notices) {
      notice.hidden = !visible;
      const link = notice.querySelector('[data-update-download]');
      if (visible) link.href = url.href;
      else link.removeAttribute('href');
      notice.querySelector('[data-update-version]').textContent = visible ? update.version : '';
    }
  }
}
