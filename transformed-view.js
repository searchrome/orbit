const api = window.transformedViewAPI;
const title = document.getElementById('view-title');
const source = document.getElementById('view-source');
const status = document.getElementById('view-status');
const content = document.getElementById('view-content');

function setState(message, state = '') {
  status.textContent = message;
  status.dataset.state = state;
}

function render(payload = {}) {
  if (payload.state === 'loading') {
    setState(payload.message || 'Loading current source content…', 'loading');
    return;
  }
  if (payload.state === 'error') {
    setState(payload.message || 'Could not refresh this view.', 'error');
    return;
  }

  title.textContent = payload.title || 'Transformed view';
  source.textContent = payload.sourceUrl || '';
  source.title = payload.sourceUrl || '';
  content.textContent = payload.content || '';
  document.body.dataset.theme = payload.theme === 'dark' ? 'dark' : 'light';
  setState(payload.updatedAt ? `Updated ${new Date(payload.updatedAt).toLocaleString()}` : 'Ready', 'ready');
}

api?.onData?.(render);
document.getElementById('refresh-view')?.addEventListener('click', () => api?.send?.('transformed-view-refresh'));
document.getElementById('open-original')?.addEventListener('click', () => api?.send?.('transformed-view-open-original'));
api?.send?.('transformed-view-ready');
