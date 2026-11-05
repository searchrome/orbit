// Integration tests for DLNA cast transport controls (play / pause / seek).
//
// A loopback DLNA renderer (real HTTP + SOAP AVTransport endpoint) models a
// renderer transport state machine. It classifies the cast media as VOD or LIVE
// purely from the HTTP headers the media server advertises (transferMode,
// content-length, accept-ranges) — exactly what a real TV uses — and refuses
// pause/seek with UPnP 701 for a live-classified stream. This reproduces the
// "Cast Pause failed: Transition not available (UPnP 701)" report without a
// physical TV and pins the relay's VOD signalling.

const http = require('http');
const DlnaCastManager = require('../../dlna-cast-manager');

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

function soapEnvelope(inner) {
    return `<?xml version="1.0" encoding="utf-8"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;
}
function soapResponse(action) {
    return soapEnvelope(`<u:${action}Response xmlns:u="${AVT}"></u:${action}Response>`);
}
function soapFault(errorCode, description) {
    return soapEnvelope(`<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${errorCode}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault>`);
}
function tag(xml, name) {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? m[1].trim() : '';
}
// REL_TIME is "H:MM:SS[.mmm]".
function timecodeToSeconds(value) {
    const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(value || '');
    if (!m) return 0;
    const millis = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + millis / 1000;
}
function secondsToTimecode(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Inspects the media the renderer was told to play and decides whether the
// renderer will allow trick modes. This mirrors a real TV: a finite,
// byte-rangeable resource advertised as Interactive/Progressive is VOD;
// anything streamed without a length is treated as live.
function classifyMedia(url) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(url); } catch { return resolve('live'); }
        const req = http.request({ hostname: target.hostname, port: target.port || 80, path: target.pathname, method: 'HEAD' }, (res) => {
            const tm = String(res.headers['transfermode.dlna.org'] || '').toLowerCase();
            const hasLength = res.headers['content-length'] != null;
            const ranged = String(res.headers['accept-ranges'] || '').toLowerCase().includes('bytes');
            const vod = (tm === 'interactive' || tm === 'progressive') && hasLength && ranged;
            res.resume();
            resolve(vod ? 'vod' : 'live');
        });
        req.on('error', () => resolve('live'));
        req.setTimeout(2000, () => { req.destroy(); resolve('live'); });
        req.end();
    });
}

// A mock DLNA MediaRenderer: an AVTransport control endpoint backed by a small
// transport state machine. Pause/Seek are refused (UPnP 701) unless the media
// was classified as VOD.
function startMockRenderer() {
    let state = 'STOPPED';
    let position = 0;
    const duration = 2530;
    let mode = 'live';

    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const xml = Buffer.concat(chunks).toString('utf8');
            const action = (xml.match(/<u:(\w+)/i) || [])[1];
            const send = (status, body) => { res.writeHead(status, { 'CONTENT-TYPE': 'text/xml; charset="utf-8"' }); res.end(body); };

            switch (action) {
                case 'SetAVTransportURI': {
                    const uri = tag(xml, 'CurrentURI');
                    // Classify the media before playback begins.
                    classifyMedia(uri).then((classified) => {
                        mode = classified;
                        state = 'STOPPED';
                        position = 0;
                        send(200, soapResponse('SetAVTransportURI'));
                    });
                    return;
                }
                case 'Play':
                    if (!mode) return send(500, soapFault(412, 'No media set'));
                    state = 'PLAYING';
                    return send(200, soapResponse('Play'));
                case 'Pause':
                    if (mode === 'live') return send(500, soapFault(701, 'Transition not available'));
                    state = 'PAUSED_PLAYBACK';
                    return send(200, soapResponse('Pause'));
                case 'Seek': {
                    const target = tag(xml, 'Target');
                    if (mode === 'live') return send(500, soapFault(701, 'Transition not available'));
                    position = timecodeToSeconds(target);
                    return send(200, soapResponse('Seek'));
                }
                case 'Stop':
                    state = 'STOPPED';
                    return send(200, soapResponse('Stop'));
                case 'GetTransportInfo':
                    return send(200, soapEnvelope(`<u:GetTransportInfoResponse xmlns:u="${AVT}"><CurrentTransportState>${state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed></u:GetTransportInfoResponse>`));
                case 'GetPositionInfo':
                    return send(200, soapEnvelope(`<u:GetPositionInfoResponse xmlns:u="${AVT}"><Track>1</Track><TrackDuration>${secondsToTimecode(duration)}</TrackDuration><RelTime>${secondsToTimecode(position)}</RelTime><AbsTime>${secondsToTimecode(position)}</AbsTime><RelCount>0</RelCount><AbsCount>0</AbsCount></u:GetPositionInfoResponse>`));
                default:
                    return send(500, soapFault(402, 'Invalid Action'));
            }
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                controlUrl: `http://127.0.0.1:${port}/upnp/control/AVTransport`,
                close: () => new Promise((r) => server.close(r))
            });
        });
    });
}

// A tiny media server standing in for the relay's stream.mp4 endpoint. It
// advertises the headers a real TV inspects, configurable per test.
function startMediaServer({ transferMode, withLength, withRanges }) {
    const body = Buffer.alloc(1024 * 1024, 7);
    const headersFor = (len) => ({
        'content-type': 'video/mp4',
        'accept-ranges': withRanges ? 'bytes' : 'none',
        'transferMode.dlna.org': transferMode,
        ...(len != null ? { 'content-length': String(len) } : {})
    });
    const server = http.createServer((req, res) => {
        if (req.method === 'HEAD') { res.writeHead(200, headersFor(withLength ? body.length : null)); res.end(); return; }
        const range = req.headers.range;
        if (range && withRanges) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            const start = Number(m[1]);
            const end = m[2] === '' ? body.length - 1 : Number(m[2]);
            res.writeHead(206, { ...headersFor(end - start + 1), 'content-range': `bytes ${start}-${end}/${body.length}` });
            res.end(body.slice(start, end + 1));
            return;
        }
        res.writeHead(200, headersFor(withLength ? body.length : null));
        res.end(body);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/cast/token/stream.mp4`,
                close: () => new Promise((r) => server.close(r))
            });
        });
    });
}

describe('DLNA cast transport controls (integration)', () => {
    let renderer;
    let media;
    let device;

    const startVodMedia = () => startMediaServer({ transferMode: 'Interactive', withLength: true, withRanges: true });
    const startLiveMedia = () => startMediaServer({ transferMode: 'Streaming', withLength: false, withRanges: false });

    beforeEach(async () => {
        renderer = await startMockRenderer();
        device = { id: 'tv-1', name: 'Living Room TV', host: '127.0.0.1', controlUrl: renderer.controlUrl };
    });

    afterEach(async () => {
        if (media) await media.close();
        if (renderer) await renderer.close();
    });

    test('plays, pauses and seeks a finite (VOD) cast', async () => {
        media = await startVodMedia();
        const manager = new DlnaCastManager();

        // "Start casting": load the media then begin playback.
        await expect(manager.castVideo(device, media.url, { omitMetadata: true })).resolves.toEqual({ ok: true, device: 'Living Room TV' });

        // Pause is honoured for a VOD resource.
        await expect(manager.pause(device)).resolves.toEqual({ ok: true, device: 'Living Room TV' });

        // Seek (forward) is honoured and expressed as a REL_TIME target.
        await expect(manager.seek(device, 125)).resolves.toEqual({ ok: true, device: 'Living Room TV' });

        // The polled status reflects the paused state and the sought position.
        const status = await manager.getStatus(device);
        expect(status.state).toBe('PAUSED_PLAYBACK');
        expect(status.position).toBeCloseTo(125, 5);
        expect(status.duration).toBeCloseTo(2530, 5);
    });

    test('refuses pause and seek with UPnP 701 on a live (Streaming) cast', async () => {
        media = await startLiveMedia();
        const manager = new DlnaCastManager();

        // Playback still starts for a live-classified stream...
        await expect(manager.castVideo(device, media.url, { omitMetadata: true })).resolves.toEqual({ ok: true, device: 'Living Room TV' });

        // ...but the renderer rejects trick modes, exactly as reported.
        await expect(manager.pause(device)).rejects.toThrow('UPnP 701');
        await expect(manager.seek(device, 30)).rejects.toThrow('UPnP 701');
    });

    test('getStatus reports PLAYING right after a cast starts', async () => {
        media = await startVodMedia();
        const manager = new DlnaCastManager();
        await manager.castVideo(device, media.url, { omitMetadata: true });
        const status = await manager.getStatus(device);
        expect(status.state).toBe('PLAYING');
        expect(status.position).toBe(0);
    });
});
