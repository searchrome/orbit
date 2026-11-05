const MAX_CUES = 4000;

// Samsung DLNA renderers read sidecar captions as SRT. The page player exposes
// WebVTT (textTracks or <track src>), so both are converted before casting.

function parseTimecode(value) {
    const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = match[4] ? Number(match[4].padEnd(3, '0')) : 0;
    if (minutes > 59 || seconds > 59 || [hours, minutes, seconds, millis].some((part) => !Number.isFinite(part))) return null;
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function formatTimecode(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const millis = Math.min(999, Math.round((total - Math.floor(total)) * 1000));
    const whole = Math.floor(total);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    const pad = (value, width) => String(value).padStart(width, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(rest, 2)},${pad(millis, 3)}`;
}

function decodeEntities(text) {
    return String(text || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function cueText(lines) {
    return decodeEntities(lines.join('\n').replace(/<[^>]*>/g, '').trim());
}

// Parses WebVTT (and tolerates the SRT-style comma milliseconds). Cue
// identifiers, NOTE/STYLE blocks, and cue settings are ignored.
function parseWebVtt(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const cues = [];
    let index = 0;
    let inBlock = false;
    while (index < lines.length && cues.length < MAX_CUES) {
        const line = lines[index].trim();
        if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/i.test(line)) {
            inBlock = true;
            index += 1;
            continue;
        }
        if (inBlock && line) {
            index += 1;
            continue;
        }
        if (inBlock && !line) {
            inBlock = false;
            index += 1;
            continue;
        }
        if (!line) {
            index += 1;
            continue;
        }
        let timingLine = '';
        let next = index;
        if (!line.includes('-->') && index + 1 < lines.length && lines[index + 1].includes('-->')) {
            next = index + 1;
        }
        timingLine = lines[next].trim();
        const match = timingLine.match(/-->/);
        if (!match) {
            index += 1;
            continue;
        }
        const [startPart, endPart] = timingLine.split('-->');
        const start = parseTimecode(startPart.trim().split(/\s+/)[0]);
        const end = parseTimecode(endPart.trim().split(/\s+/)[0]);
        const textLines = [];
        for (next += 1; next < lines.length && lines[next].trim(); next += 1) {
            textLines.push(lines[next].trim());
        }
        const text = cueText(textLines);
        if (start !== null && end !== null && end > start && text) {
            cues.push({ start, end, text });
        }
        index = next;
    }
    return { cues };
}

function cuesToSrt(cues) {
    const lines = [];
    let number = 0;
    for (const cue of (Array.isArray(cues) ? cues : []).slice(0, MAX_CUES)) {
        const start = Number(cue?.start);
        const end = Number(cue?.end);
        const text = cueText([String(cue?.text || '')]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
        number += 1;
        lines.push(String(number), `${formatTimecode(start)} --> ${formatTimecode(end)}`, text, '');
    }
    return lines.join('\n').trim() ? `${lines.join('\n').trim()}\n` : '';
}

module.exports = {
    MAX_CUES,
    cuesToSrt,
    decodeEntities,
    formatTimecode,
    parseTimecode,
    parseWebVtt
};
