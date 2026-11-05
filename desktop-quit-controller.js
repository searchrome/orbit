// Explicit Quit must wait for the existing save-on-close flow. Calling app.quit()
// before that flow finishes lets a window's preventDefault cancel the native quit.
class DesktopQuitController {
  constructor({ app, getWindows, shutdown, logger = console, cleanupTimeoutMs = 5000 }) {
    this.app = app;
    this.getWindows = getWindows;
    this.shutdown = shutdown;
    this.logger = logger;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.requested = false;
    this.finished = false;
    this.finishing = null;
    app.on('before-quit', event => {
      if (this.finished) return;
      event.preventDefault();
      if (this.requested) return;
      this.requested = true;
      // close() asks each renderer to save. Its acknowledgement destroys the
      // window only after its tab/group journal has been written to disk.
      for (const window of this.getWindows()) {
        if (!window.isDestroyed()) window.close();
      }
      this.onWindowsChanged();
    });
    app.on('window-all-closed', () => this.onWindowsChanged());
  }

  onWindowsChanged() {
    if (!this.requested || this.finished || this.finishing || this.getWindows().length) return;
    this.finishing = this.finish();
  }

  async finish() {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.shutdown()),
        new Promise(resolve => {
          timer = setTimeout(() => {
            this.logger.warn('[Orbit] Background cleanup exceeded the quit deadline; session data is already saved.');
            resolve();
          }, this.cleanupTimeoutMs);
        })
      ]);
    } catch (error) {
      this.logger.warn(`[Orbit] Quit cleanup failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
      this.finished = true;
      // There are no remaining windows to cancel this final native quit.
      this.app.quit();
    }
  }
}
module.exports = DesktopQuitController;
