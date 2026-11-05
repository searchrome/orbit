function message(error) {
    return error?.message || String(error || 'Cast failed.');
}

function extractMime(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
    if (/\.webm(\?|$)/i.test(url)) return 'video/webm';
    if (/\.mkv(\?|$)/i.test(url)) return 'video/x-matroska';
    if (/\.mov(\?|$)/i.test(url)) return 'video/quicktime';
    return 'video/mp4';
}

export default class CastPanel {
    constructor(tabManager) {
        this.tabManager = tabManager;
        this.panel = document.getElementById('cast-panel');
        this.openButton = document.getElementById('cast-btn');
        this.closeButton = document.getElementById('cast-close-btn');
        this.refreshButton = document.getElementById('cast-refresh-btn');
        this.castButton = document.getElementById('cast-video-btn');
        this.stopButton = document.getElementById('cast-stop-btn');
        this.sessionBox = document.getElementById('cast-session');
        this.seekRange = document.getElementById('cast-seek-range');
        this.playButton = document.getElementById('cast-play-btn');
        this.rewindButton = document.getElementById('cast-rewind-btn');
        this.forwardButton = document.getElementById('cast-forward-btn');
        this.timeCurrent = document.getElementById('cast-time-current');
        this.timeTotal = document.getElementById('cast-time-total');
        this.status = document.getElementById('cast-status');
        this.list = document.getElementById('cast-device-list');
        this.subtitleQuery = document.getElementById('cast-subtitle-query');
        this.subtitleSearchButton = document.getElementById('cast-subtitle-search-btn');
        this.subtitleList = document.getElementById('cast-subtitle-list');
        this.devices = [];
        this.selectedDevice = null;
        this.lastExtractionMessage = '';
        this.selectedSubtitle = null;
        // Page URL the subtitle search box / picked subtitle were derived from,
        // so they can be invalidated when the user moves to another video.
        this.subtitlePageUrl = '';
        this.preparing = false;
        window.electronAPI?.on?.('cast-progress', (progress) => {
            if (!this.preparing || !progress) return;
            const mb = progress.capturedMb > 0 ? ` — ${progress.capturedMb} MB` : '';
            const percent = Number.isFinite(progress.percent) ? ` (${progress.percent}%)` : '';
            this.setStatus(`Preparing the video for the TV${percent}${mb}…`);
        });
        if (!this.panel || !this.openButton || !this.status || !this.list) return;

        this.openButton.addEventListener('click', () => this.show());
        this.closeButton?.addEventListener('click', () => this.hide());
        this.refreshButton?.addEventListener('click', () => this.discover());
        this.castButton?.addEventListener('click', () => this.castActiveTabVideo());
        this.stopButton?.addEventListener('click', () => this.stopCasting());
        this.subtitleSearchButton?.addEventListener('click', () => this.searchSubtitles());
        this.subtitleQuery?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.searchSubtitles();
            }
        });
        this.playButton?.addEventListener('click', () => this.togglePlayback());
        this.rewindButton?.addEventListener('click', () => this.nudgePosition(-10));
        this.forwardButton?.addEventListener('click', () => this.nudgePosition(10));
        this.seekRange?.addEventListener('input', () => {
            if (this.session) this.session.dragging = true;
        });
        this.seekRange?.addEventListener('change', () => {
            const value = Number(this.seekRange.value);
            if (this.session) this.session.dragging = false;
            if (Number.isFinite(value)) this.sendTransport('seek', { seconds: value });
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.hide();
        });
    }

    setStatus(value, state = '') {
        if (!this.status) return;
        this.status.textContent = value;
        if (state) this.status.dataset.state = state;
        else delete this.status.dataset.state;
    }

    async show() {
        if (!this.panel) return;
        this.panel.hidden = false;
        const webview = this.tabManager.getActiveWebview?.();
        const pageUrl = typeof webview?.getURL === 'function' ? webview.getURL() : '';
        if (pageUrl !== this.subtitlePageUrl) {
            // The active page changed since the subtitle state was captured —
            // the old title/selection belongs to the previous video.
            this.subtitlePageUrl = pageUrl;
            const title = typeof webview?.getTitle === 'function' ? webview.getTitle() : '';
            this.subtitleQuery.value = title ? title.replace(/^\s*(watch|stream|online|free|full)\b[\s:—-]*/i, '').trim() : '';
            this.selectedSubtitle = null;
            this.subtitleList?.replaceChildren();
        }
        if (!this.devices.length) await this.discover();
    }

    hide() {
        if (this.panel) this.panel.hidden = true;
    }

    async discover() {
        this.refreshButton && (this.refreshButton.disabled = true);
        this.setStatus('Searching this network for cast devices…');
        try {
            this.devices = await window.electronAPI.invoke('cast-discover-devices') || [];
            if (!this.devices.length) this.setStatus('No DLNA/UPnP cast devices found. Make sure the TV is on the same network.', 'error');
            else this.setStatus(`Found ${this.devices.length} device${this.devices.length === 1 ? '' : 's'}. Select one, then cast.`);
            this.renderDevices();
        } catch (error) {
            this.setStatus(message(error), 'error');
        } finally {
            this.refreshButton && (this.refreshButton.disabled = false);
        }
    }

    renderDevices() {
        this.list.replaceChildren();
        for (const device of this.devices) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'cast-device';
            if (this.selectedDevice?.id === device.id) row.classList.add('cast-device--selected');
            const name = document.createElement('strong');
            name.textContent = device.name || 'Unknown device';
            const meta = document.createElement('span');
            meta.textContent = device.host || '';
            row.append(name, meta);
            row.addEventListener('click', () => {
                this.selectedDevice = device;
                this.renderDevices();
                this.setStatus(`Selected ${device.name}. Cast the video playing in the current tab.`);
            });
            this.list.appendChild(row);
        }
        if (!this.devices.length) {
            const empty = document.createElement('div');
            empty.className = 'cast-device-empty';
            empty.textContent = 'No devices found yet. Press ↻ to search again.';
            this.list.appendChild(empty);
        }
    }

    async extractActiveTabVideo() {
        const webview = this.tabManager.getActiveWebview?.();
        if (!webview) return null;
        const webContentsId = Number(webview.getWebContentsId?.());
        if (!Number.isInteger(webContentsId)) return null;
        const pageUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
        const parsed = await window.electronAPI.invoke('cast-extract-video', { webContentsId });
        if (parsed?.relayStream) {
            this.lastExtractionMessage = '';
            return {
                transport: 'relay',
                webContentsId,
                pageUrl,
                title: parsed.title || 'Video from Entrim Browser',
                mimeType: parsed.relayStream.mimeType,
                subtitleToken: parsed.subtitles?.token || ''
            };
        }
        const video = parsed?.videos?.[0];
        if (!video) {
            this.lastExtractionMessage = parsed?.videoElementCount
                ? 'A video was found, but it does not expose a direct HTTP(S) stream that can be sent to the TV.'
                : parsed?.frameCount > 1
                    ? 'The video player is embedded, but it does not expose a direct HTTP(S) stream that can be sent to the TV.'
                    : 'No direct video stream found in this tab. Open the video itself, then try again.';
            return null;
        }
        this.lastExtractionMessage = '';
        return {
            transport: 'direct',
            url: video.url,
            pageUrl,
            title: parsed.title || video.label || 'Video from Entrim Browser',
            mimeType: extractMime(video.url),
            subtitleToken: parsed.subtitles?.token || ''
        };
    }

    // OpenSubtitles: an editable search whose results the user picks from.
    async searchSubtitles() {
        if (!this.subtitleSearchButton) return;
        const query = this.subtitleQuery.value.trim();
        if (!query) {
            this.setStatus('Type a show or movie name to find subtitles.', 'error');
            return;
        }
        this.subtitleSearchButton.disabled = true;
        this.setStatus('Searching OpenSubtitles…');
        try {
            const webview = this.tabManager.getActiveWebview?.();
            const pageUrl = typeof webview?.getURL === 'function' ? webview.getURL() : '';
            const { results } = await window.electronAPI.invoke('cast-subtitle-search', { query, url: pageUrl });
            this.renderSubtitleResults(results || []);
            this.setStatus(`Found ${results.length} subtitle${results.length === 1 ? '' : 's'} — select one to cast with the video.`);
        } catch (error) {
            this.renderSubtitleResults([]);
            this.setStatus(message(error), 'error');
        } finally {
            this.subtitleSearchButton.disabled = false;
        }
    }

    renderSubtitleResults(results) {
        if (!this.subtitleList) return;
        this.subtitleList.replaceChildren();
        if (!results.length) {
            const empty = document.createElement('div');
            empty.className = 'cast-subtitles__empty';
            empty.textContent = 'No results. Try a shorter name, or add the season.';
            this.subtitleList.appendChild(empty);
            return;
        }
        for (const result of results) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'cast-subtitle';
            row.dataset.fileId = String(result.fileId);
            if (this.selectedSubtitle?.fileId === result.fileId) row.classList.add('cast-subtitle--selected');
            const title = document.createElement('strong');
            const where = [result.feature, result.season != null ? `S${String(result.season).padStart(2, '0')}` : '', result.episode != null ? `E${String(result.episode).padStart(2, '0')}` : ''].filter(Boolean).join(' ');
            title.textContent = where || result.label;
            title.title = result.label;
            const meta = document.createElement('span');
            const flags = [result.language.toUpperCase(), result.hearingImpaired ? 'SDH' : '', result.aiTranslated ? 'AI' : ''].filter(Boolean).join(' · ');
            meta.textContent = `${flags}${flags ? ' — ' : ''}${result.label}`;
            row.append(title, meta);
            row.addEventListener('click', () => this.downloadSubtitle(row, result));
            this.subtitleList.appendChild(row);
        }
    }

    async downloadSubtitle(row, result) {
        this.setStatus('Downloading subtitles…');
        try {
            const downloaded = await window.electronAPI.invoke('cast-subtitle-download', {
                fileId: result.fileId,
                label: result.label,
                language: result.language
            });
            const webview = this.tabManager.getActiveWebview?.();
            this.selectedSubtitle = {
                fileId: result.fileId,
                token: downloaded.token,
                label: downloaded.label,
                // The subtitle belongs to the video on this page; it must not be
                // reused if the user moves to a different video/page.
                pageUrl: typeof webview?.getURL === 'function' ? webview.getURL() : ''
            };
            this.subtitleList.querySelectorAll('.cast-subtitle').forEach((item) => item.classList.remove('cast-subtitle--selected'));
            row.classList.add('cast-subtitle--selected');
            this.setStatus(`Subtitles selected: ${downloaded.label} — they are cast with the video.`);
        } catch (error) {
            // The file may have been removed on OpenSubtitles (HTTP 404); mark
            // the row so the user picks another instead of retrying a dead one.
            row.classList.add('cast-subtitle--error');
            row.disabled = true;
            this.setStatus(message(error), 'error');
        }
    }

    async castActiveTabVideo() {
        if (!this.selectedDevice) {
            this.setStatus('Select a TV first.', 'error');
            return;
        }
        this.castButton && (this.castButton.disabled = true);
        this.setStatus('Reading the current tab for a video…');
        try {
            const media = await this.extractActiveTabVideo();
            if (!media) {
                this.setStatus(this.lastExtractionMessage || 'No direct video stream found in this tab. Open the video itself, then try again.', 'error');
                return;
            }
            let droppedSubtitleNote = '';
            if (this.selectedSubtitle?.token && this.selectedSubtitle.pageUrl !== media.pageUrl) {
                // The picked subtitle belongs to the previous video on this
                // page; reusing it would cast mismatched captions.
                this.selectedSubtitle = null;
                droppedSubtitleNote = ' The page changed, so the previously picked subtitles were cleared.';
            }
            let subtitleSuffix = '';
            if (this.selectedSubtitle?.token) {
                media.subtitleToken = this.selectedSubtitle.token;
                subtitleSuffix = ` Subtitles: ${this.selectedSubtitle.label}`;
            } else if (media.subtitleToken) {
                subtitleSuffix = ' Subtitles are attached — enable them with the TV remote\'s CC button.';
            } else {
                subtitleSuffix = ' No captions found — use the Subtitles section to pick one.';
            }
            if (media.transport === 'relay') {
                this.setStatus('Preparing the video for the TV — longer videos can take several minutes…');
                this.preparing = true;
            }
            const result = media.transport === 'relay'
                ? await window.electronAPI.invoke('cast-relay-video', {
                    device: this.selectedDevice,
                    webContentsId: media.webContentsId,
                    title: media.title,
                    subtitleToken: media.subtitleToken
                })
                : await window.electronAPI.invoke('cast-video', {
                    device: this.selectedDevice,
                    videoUrl: media.url,
                    subtitleToken: media.subtitleToken,
                    metadata: { title: media.title, mimeType: media.mimeType }
                });
            this.setStatus(`Casting to ${result?.device || this.selectedDevice.name}.${subtitleSuffix}${result?.reused ? ' Reused the earlier download.' : ''}${droppedSubtitleNote}`);
            this.startSession();
        } catch (error) {
            this.setStatus(message(error), 'error');
        } finally {
            this.preparing = false;
            this.castButton && (this.castButton.disabled = false);
        }
    }

    startSession() {
        this.session = { device: this.selectedDevice, timer: null, dragging: false };
        if (this.sessionBox) this.sessionBox.hidden = false;
        if (this.seekRange) this.seekRange.value = '0';
        this.updateControls({ state: 'PLAYING', position: 0, duration: null });
        this.session.timer = setInterval(() => this.refreshSession(), 2000);
    }

    endSession() {
        if (this.session?.timer) clearInterval(this.session.timer);
        this.session = null;
        if (this.sessionBox) this.sessionBox.hidden = true;
    }

    async refreshSession() {
        if (!this.session) return;
        try {
            const status = await window.electronAPI.invoke('cast-status', { device: this.session.device });
            if (status?.state === 'STOPPED' || status?.state === 'NO_MEDIA_PRESENT') {
                this.endSession();
                this.setStatus('The TV stopped playback.');
                return;
            }
            this.updateControls(status);
        } catch {
            // Transient SOAP hiccups should not tear the session down.
        }
    }

    updateControls(status) {
        if (!this.session) return;
        const playing = status?.state === 'PLAYING' || status?.state === 'TRANSITIONING';
        if (this.playButton) this.playButton.textContent = playing ? 'Pause' : 'Play';
        if (this.seekRange && !this.session.dragging) {
            const duration = Number.isFinite(status?.duration) && status.duration > 0 ? status.duration : Number(this.seekRange.max) || 0;
            if (duration > 0) this.seekRange.max = String(Math.floor(duration));
            if (Number.isFinite(status?.position)) this.seekRange.value = String(Math.floor(status.position));
        }
        if (this.timeCurrent && Number.isFinite(status?.position)) this.timeCurrent.textContent = formatClock(status.position);
        if (this.timeTotal && Number.isFinite(status?.duration) && status.duration > 0) this.timeTotal.textContent = formatClock(status.duration);
    }

    async sendTransport(action, extra = {}, attempt = 0) {
        if (!this.session) return;
        const channel = action === 'play' ? 'cast-play'
            : action === 'pause' ? 'cast-pause'
                : action === 'seek' ? 'cast-seek' : null;
        if (!channel) return;
        try {
            const result = await window.electronAPI.invoke(channel, { device: this.session.device, ...extra });
            if (channel === 'cast-seek' && Number.isFinite(Number(extra.seconds))) {
                const target = formatClock(extra.seconds);
                if (result?.restarted) this.setStatus(`Moved to ${target} — the TV restarted playback at that point.`);
                else if (result?.ok) this.setStatus(`Moved to ${target}.`);
            }
        } catch (error) {
            // Renderers briefly refuse transitions while buffering (UPnP 701).
            if (attempt < 2 && /701|transition/i.test(String(error?.message || ''))) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                return this.sendTransport(action, extra, attempt + 1);
            }
            this.setStatus(message(error), 'error');
        }
    }

    togglePlayback() {
        if (!this.session) return;
        const playing = this.playButton?.textContent === 'Pause';
        this.playButton && (this.playButton.textContent = playing ? 'Play' : 'Pause');
        void this.sendTransport(playing ? 'pause' : 'play');
    }

    nudgePosition(delta) {
        if (!this.session) return;
        const current = Number(this.seekRange?.value) || 0;
        const max = Number(this.seekRange?.max) || 0;
        const target = Math.min(Math.max(0, current + delta), max);
        if (this.seekRange) this.seekRange.value = String(Math.floor(target));
        if (this.timeCurrent) this.timeCurrent.textContent = formatClock(target);
        void this.sendTransport('seek', { seconds: target });
    }

    async stopCasting() {
        this.stopButton && (this.stopButton.disabled = true);
        try {
            await window.electronAPI.invoke('cast-stop', { device: this.selectedDevice });
            this.endSession();
            this.setStatus('Stopped casting.');
        } catch (error) {
            this.setStatus(message(error), 'error');
        } finally {
            this.stopButton && (this.stopButton.disabled = false);
        }
    }

}

function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export { extractMime };
