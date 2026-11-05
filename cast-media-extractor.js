const VIDEO_CANDIDATE_SCRIPT = `(() => {
    const videos = [];
    let videoElementCount = 0;
    let nonDirectVideoCount = 0;
    const push = (url, label) => {
        if (!url) return;
        if (/^https?:\\/\\//i.test(url)) {
            videos.push({ url, label: label || '' });
        } else if (/^(blob:|mediasource:)/i.test(url)) {
            nonDirectVideoCount++;
        }
    };
    for (const video of document.querySelectorAll('video')) {
        videoElementCount++;
        push(video.currentSrc || video.src, video.getAttribute('title'));
        for (const source of video.querySelectorAll('source')) push(source.src, video.getAttribute('title'));
    }
    return JSON.stringify({
        title: document.title || '',
        videoElementCount,
        nonDirectVideoCount,
        videos
    });
})()`;

const PLAYBACK_STATE_SCRIPT = `(() => {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return JSON.stringify({ found: false });
    const video = videos.sort((a, b) => {
        const score = (item) => (item.paused ? 0 : 100000000) + (item.videoWidth || 0) * (item.videoHeight || 0);
        return score(b) - score(a);
    })[0];
    return JSON.stringify({
        found: true,
        paused: !!video.paused,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        videoWidth: video.videoWidth || 0,
        videoHeight: video.videoHeight || 0,
        subtitleTracks: [...video.textTracks].map((track) => ({
            label: track.label || '',
            language: track.language || '',
            kind: track.kind || '',
            mode: track.mode || 'disabled'
        }))
    });
})()`;

const SUBTITLE_EXTRACTION_SCRIPT = `(() => {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return JSON.stringify({ found: false });
    const score = (item) => (item.paused ? 0 : 100000000) + (item.videoWidth || 0) * (item.videoHeight || 0);
    const video = videos.sort((a, b) => score(b) - score(a))[0];
    const trackElement = video.querySelector('track[kind="subtitles"], track[kind="captions"]');
    const trackSrc = /^(https?:\\/\\/)/i.test(trackElement?.src || '') ? trackElement.src : '';
    const tracks = [...video.textTracks].filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
    let track = tracks.find((candidate) => candidate.mode === 'showing')
        || tracks.find((candidate) => candidate.mode === 'hidden' && candidate.cues && candidate.cues.length);
    if (!track && tracks.length) {
        // Disabled tracks only load their cues once they are shown or hidden.
        for (const candidate of tracks) {
            if (candidate.mode === 'disabled') candidate.mode = 'hidden';
        }
        track = tracks.find((candidate) => candidate.cues && candidate.cues.length) || tracks[0];
    }
    if (!track) {
        return JSON.stringify({
            found: !!trackSrc,
            trackSrc,
            label: trackElement?.label || '',
            language: trackElement?.srclang || '',
            cues: []
        });
    }
    const cues = [];
    const list = track.cues || [];
    for (let index = 0; index < list.length && cues.length < 4000; index++) {
        const cue = list[index];
        const text = String(cue.text || '').trim();
        if (!text || !(cue.endTime > cue.startTime)) continue;
        cues.push({ start: cue.startTime, end: cue.endTime, text });
    }
    return JSON.stringify({
        found: cues.length > 0,
        trackSrc,
        label: track.label || '',
        language: track.language || '',
        cues
    });
})()`;

function parseFrameResult(raw) {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            videoElementCount: Number.isInteger(parsed.videoElementCount) ? parsed.videoElementCount : 0,
            nonDirectVideoCount: Number.isInteger(parsed.nonDirectVideoCount) ? parsed.nonDirectVideoCount : 0,
            videos: Array.isArray(parsed.videos) ? parsed.videos : []
        };
    } catch {
        return null;
    }
}

function parsePlaybackResult(raw) {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || !parsed.found) return null;
        return {
            found: true,
            paused: !!parsed.paused,
            currentTime: Number.isFinite(parsed.currentTime) ? Math.max(0, parsed.currentTime) : 0,
            duration: Number.isFinite(parsed.duration) ? Math.max(0, parsed.duration) : null,
            playbackRate: Number.isFinite(parsed.playbackRate) ? parsed.playbackRate : 1,
            videoWidth: Number.isInteger(parsed.videoWidth) ? parsed.videoWidth : 0,
            videoHeight: Number.isInteger(parsed.videoHeight) ? parsed.videoHeight : 0,
            subtitleTracks: Array.isArray(parsed.subtitleTracks) ? parsed.subtitleTracks : []
        };
    } catch {
        return null;
    }
}

function parseSubtitleResult(raw) {
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || !parsed.found) return null;
        const cues = [];
        for (const cue of Array.isArray(parsed.cues) ? parsed.cues : []) {
            const start = Number(cue?.start);
            const end = Number(cue?.end);
            const text = typeof cue?.text === 'string' ? cue.text : '';
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
            cues.push({ start, end, text });
        }
        const trackSrc = typeof parsed.trackSrc === 'string' && /^https?:\/\//i.test(parsed.trackSrc) ? parsed.trackSrc : '';
        return {
            found: cues.length > 0 || !!trackSrc,
            trackSrc,
            label: typeof parsed.label === 'string' ? parsed.label : '',
            language: typeof parsed.language === 'string' ? parsed.language : '',
            cues
        };
    } catch {
        return null;
    }
}

function collectFrames(frame, result = [], seen = new Set()) {
    if (!frame || seen.has(frame) || frame.isDestroyed?.()) return result;
    seen.add(frame);
    result.push(frame);
    for (const child of frame.frames || []) collectFrames(child, result, seen);
    return result;
}

async function extractVideoFromWebContents(contents) {
    const frames = collectFrames(contents?.mainFrame);
    const responses = await Promise.all(frames.map(async (frame) => {
        try {
            return parseFrameResult(await frame.executeJavaScript(VIDEO_CANDIDATE_SCRIPT));
        } catch {
            return null;
        }
    }));

    const videos = [];
    const seen = new Set();
    let title = '';
    let videoElementCount = 0;
    let nonDirectVideoCount = 0;
    for (const response of responses) {
        if (!response) continue;
        if (!title && response.title) title = response.title;
        videoElementCount += response.videoElementCount;
        nonDirectVideoCount += response.nonDirectVideoCount;
        for (const candidate of response.videos) {
            const url = typeof candidate?.url === 'string' ? candidate.url : '';
            if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
            seen.add(url);
            videos.push({ url, label: typeof candidate.label === 'string' ? candidate.label : '' });
        }
    }

    return {
        title,
        videos: videos.slice(0, 10),
        frameCount: frames.length,
        videoElementCount,
        nonDirectVideoCount
    };
}

async function getPlaybackStateFromWebContents(contents) {
    const frames = collectFrames(contents?.mainFrame);
    const responses = await Promise.all(frames.map(async (frame) => {
        try {
            return parsePlaybackResult(await frame.executeJavaScript(PLAYBACK_STATE_SCRIPT));
        } catch {
            return null;
        }
    }));
    const candidates = responses.filter(Boolean);
    candidates.sort((a, b) => {
        const score = (item) => (item.paused ? 0 : 100000000) + item.videoWidth * item.videoHeight;
        return score(b) - score(a);
    });
    return candidates[0] || { found: false, paused: true, currentTime: 0, duration: null, playbackRate: 1, subtitleTracks: [] };
}

async function extractSubtitlesFromWebContents(contents) {
    const frames = collectFrames(contents?.mainFrame);
    const responses = await Promise.all(frames.map(async (frame) => {
        try {
            return parseSubtitleResult(await frame.executeJavaScript(SUBTITLE_EXTRACTION_SCRIPT));
        } catch {
            return null;
        }
    }));
    // The frame with the most text is most likely the one driving the picture.
    const best = responses.filter(Boolean).sort((a, b) => b.cues.length - a.cues.length)[0];
    return best || { found: false, trackSrc: '', label: '', language: '', cues: [] };
}

module.exports = {
    VIDEO_CANDIDATE_SCRIPT,
    PLAYBACK_STATE_SCRIPT,
    SUBTITLE_EXTRACTION_SCRIPT,
    collectFrames,
    extractVideoFromWebContents,
    extractSubtitlesFromWebContents,
    getPlaybackStateFromWebContents,
    parseFrameResult,
    parsePlaybackResult,
    parseSubtitleResult
};
