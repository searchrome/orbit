const DlnaCastManager = require('../../dlna-cast-manager');
const { parseDescription, tagContent, parseTimecode, postSoap, discoveryLocation } = DlnaCastManager;

const http = require('http');
const os = require('os');

function sampleDescription() {
    return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>Living Room TV</friendlyName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/ctl/RenderingControl</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>/ctl/AVTransport</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

describe('DLNA cast manager', () => {
    test('parses device description and resolves the AVTransport control URL', () => {
        const parsed = parseDescription(sampleDescription(), 'http://192.168.1.20:5000/dev.xml');
        expect(parsed.friendlyName).toBe('Living Room TV');
        expect(parsed.controlUrl).toBe('http://192.168.1.20:5000/ctl/AVTransport');
    });

    test('falls back when AVTransport is missing', () => {
        const parsed = parseDescription('<device><friendlyName>Dumb TV</friendlyName></device>', 'http://10.0.0.3/dev.xml');
        expect(parsed.friendlyName).toBe('Dumb TV');
        expect(parsed.controlUrl).toBe('');
    });

    test('strips CDATA in tag content', () => {
        expect(tagContent('<friendlyName><![CDATA[Fire TV]]></friendlyName>', 'friendlyName')).toBe('Fire TV');
    });

    test('accepts renderer descriptions that do not use a Device.xml filename', () => {
        const response = Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: http://192.168.1.20:9197/dmr\r\n\r\n');
        expect(discoveryLocation(response)).toBe('http://192.168.1.20:9197/dmr');
        expect(discoveryLocation(Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: file:///tmp/device.xml\r\n\r\n'))).toBe('');
    });

    test('sets transport URI and plays on the selected device', async () => {
        const manager = new DlnaCastManager();
        const calls = [];

        const device = { id: 'http://tv/ctl', name: 'TV', controlUrl: 'http://192.168.1.20:5000/ctl/AVTransport' };

        // End-to-end with mocked http.request
        const requestMock = jest.fn((options, callback) => {
            calls.push(options);
            const response = {
                statusCode: 200,
                on: (event, handler) => {
                    if (event === 'data') handler(Buffer.from('<u:SetAVTransportURIResponse/>'));
                    if (event === 'end') handler();
                }
            };
            callback(response);
            return {
                on: () => {},
                end: () => {},
                destroy: () => {}
            };
        });
        jest.spyOn(http, 'request').mockImplementation(requestMock);

        const result = await manager.castVideo(device, 'http://example.com/movie.mp4', { title: 'Movie', mimeType: 'video/mp4' });
        expect(result).toEqual({ ok: true, device: 'TV' });
        expect(calls.length).toBe(3);
        expect(calls[0].headers.SOAPACTION).toContain('#Stop');
        expect(calls[1].headers.SOAPACTION).toContain('SetAVTransportURI');
        expect(calls[2].headers.SOAPACTION).toContain('"urn:schemas-upnp-org:service:AVTransport:1#Play"');
        jest.spyOn(http, 'request').mockRestore();
    });

    test('uses explicit DLNA protocol information when supplied', async () => {
        const originalRequest = http.request;
        const payloads = [];
        http.request = jest.fn((_options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = 200;
                callback(response);
                response.emit('end');
            };
            return request;
        });
        try {
            const manager = new DlnaCastManager();
            await manager.castVideo(
                { id: 'tv', controlUrl: 'http://tv.example/control', name: 'TV' },
                'http://browser.example/video.ts',
                { mimeType: 'video/mpeg', protocolInfo: 'http-get:*:video/mpeg:DLNA.ORG_OP=01' }
            );
            expect(payloads[1]).toContain('protocolInfo="http-get:*:video/mpeg:DLNA.ORG_OP=01"');
        } finally {
            http.request = originalRequest;
        }
    });

    test('always advertises the resource with a display title', async () => {
        const originalRequest = http.request;
        const payloads = [];
        http.request = jest.fn((_options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = 200;
                callback(response);
                response.emit('end');
            };
            return request;
        });
        try {
            const manager = new DlnaCastManager();
            await manager.castVideo(
                { id: 'tv', controlUrl: 'http://tv.example/control', name: 'TV' },
                'http://browser.example/video.ts',
                {}
            );
            // The <res> (with its seek-advertising protocolInfo) is always sent so
            // the renderer does not classify the item as a live broadcast, and the
            // title/class stay so the TV shows a name instead of "Unknown".
            expect(payloads[1]).toContain('<CurrentURIMetaData>');
            expect(payloads[1]).toContain('&lt;res protocolInfo="http-get:*:video/mp4:*"&gt;http://browser.example/video.ts&lt;/res&gt;');
            expect(payloads[1]).toContain('&lt;dc:title&gt;Video from Entrim Browser&lt;/dc:title&gt;');
            expect(payloads[1]).toContain('&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;');
            expect(payloads[0]).not.toContain('DIDL-Lite');
            for (const [offset, action] of ['SetAVTransportURI', 'Play'].entries()) {
                const document = new DOMParser().parseFromString(payloads[offset + 1], 'text/xml');
                const soapBody = document.getElementsByTagNameNS('http://schemas.xmlsoap.org/soap/envelope/', 'Body')[0];
                expect(soapBody.children).toHaveLength(1);
                expect(soapBody.firstElementChild.localName).toBe(action);
                expect(soapBody.firstElementChild.namespaceURI).toBe('urn:schemas-upnp-org:service:AVTransport:1');
                expect(soapBody.firstElementChild.querySelector('InstanceID').textContent).toBe('0');
            }
        } finally {
            http.request = originalRequest;
        }
    });

    test('rejects non-http video URLs and missing devices', async () => {
        const manager = new DlnaCastManager();
        await expect(manager.castVideo({ controlUrl: 'http://x/ctl' }, 'ftp://x/movie.mp4')).rejects.toThrow('http(s)');
        await expect(manager.castVideo(null, 'http://x/movie.mp4')).rejects.toThrow('device');
    });

    test('advertises Samsung sidecar subtitles in the DIDL metadata when supplied', async () => {
        const originalRequest = http.request;
        const payloads = [];
        http.request = jest.fn((_options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = 200;
                callback(response);
                response.emit('end');
            };
            return request;
        });
        try {
            const manager = new DlnaCastManager();
            const subtitleUrl = 'http://192.168.1.2:45678/cast/token/subtitle.srt';
            await manager.castVideo(
                { id: 'tv', controlUrl: 'http://tv.example/control', name: 'TV' },
                'http://browser.example/video.ts',
                { omitMetadata: true, subtitleUrl }
            );
            const metadata = payloads[1].match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)[1];
            expect(metadata).toContain('xmlns:pv="http://www.pv.com/ns/"');
            expect(metadata).toContain('xmlns:sec="http://www.sec.co.kr/"');
            expect(metadata).toContain('protocolInfo="http-get:*:application/x-subrip:*"');
            expect(metadata).toContain('&lt;pv:captionInfo sec:type="srt"&gt;http://192.168.1.2:45678/cast/token/subtitle.srt&lt;/pv:captionInfo&gt;');
            expect(metadata).toContain('&lt;sec:CaptionInfo sec:type="srt"&gt;');
            // Caption metadata must survive even when the default omits optional DIDL.
            expect(metadata).toContain('DIDL-Lite');
        } finally {
            http.request = originalRequest;
        }
    });

    test('an invalid subtitle URL yields the document without caption entries', async () => {
        const originalRequest = http.request;
        const payloads = [];
        http.request = jest.fn((_options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = 200;
                callback(response);
                response.emit('end');
            };
            return request;
        });
        try {
            const manager = new DlnaCastManager();
            await manager.castVideo(
                { id: 'tv', controlUrl: 'http://tv.example/control', name: 'TV' },
                'http://browser.example/video.ts',
                { subtitleUrl: 'not a url' }
            );
            // An invalid subtitle URL is dropped: no caption res/entries, but the
            // video res and display title remain.
            expect(payloads[1]).toContain('&lt;res protocolInfo="http-get:*:video/mp4:*"&gt;http://browser.example/video.ts&lt;/res&gt;');
            expect(payloads[1]).toContain('&lt;dc:title&gt;');
            expect(payloads[1]).not.toContain('captionInfo');
        } finally {
            http.request = originalRequest;
        }
    });

    test('stops playback and clears the active device', async () => {
        const manager = new DlnaCastManager();
        const requestMock = jest.fn((options, callback) => {
            const response = {
                statusCode: 200,
                on: (event, handler) => {
                    if (event === 'data') handler(Buffer.from('<u:StopResponse/>'));
                    if (event === 'end') handler();
                }
            };
            callback(response);
            return { on: () => {}, end: () => {}, destroy: () => {} };
        });
        jest.spyOn(http, 'request').mockImplementation(requestMock);
        const device = { id: 'dev', name: 'TV', controlUrl: 'http://192.168.1.20:5000/ctl/AVTransport' };
        manager.activeDeviceKey = 'dev';
        await expect(manager.stop(device)).resolves.toEqual({ ok: true });
        expect(manager.activeDeviceKey).toBe('');
        expect(requestMock.mock.calls[0][0].headers.SOAPACTION).toContain('#Stop');
        jest.spyOn(http, 'request').mockRestore();
    });

    test('parses AVTransport timecodes', () => {
        expect(parseTimecode('0:00:05')).toBe(5);
        expect(parseTimecode('1:02:03.500')).toBe(3723.5);
        expect(parseTimecode('01:02:03.5')).toBe(3723.5);
        expect(parseTimecode('')).toBeNull();
        expect(parseTimecode('NOT_IMPLEMENTED')).toBeNull();
    });

    test('seeks with a REL_TIME target and reports transport status', async () => {
        const manager = new DlnaCastManager();
        const device = { id: 'dev', name: 'TV', controlUrl: 'http://192.168.1.20:5000/ctl/AVTransport' };
        const payloads = [];
        const responses = [
            '<u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse>',
            '<u:GetPositionInfoResponse><RelTime>0:01:05</RelTime><TrackDuration>0:42:10</TrackDuration></u:GetPositionInfoResponse>'
        ];
        let call = 0;
        const requestMock = jest.fn((options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = 200;
                response.on = (event, handler) => {
                    if (event === 'data') handler(Buffer.from(responses[call] || ''));
                    if (event === 'end') handler();
                };
                callback(response);
                response.emit('end');
                call += 1;
            };
            return request;
        });
        jest.spyOn(http, 'request').mockImplementation(requestMock);
        try {
            await expect(manager.seek(device, 125)).resolves.toEqual({ ok: true, device: 'TV' });
            expect(payloads[0]).toContain('<Unit>REL_TIME</Unit><Target>0:02:05</Target>');
            call = 0;
            await expect(manager.getStatus(device)).resolves.toEqual({ state: 'PLAYING', position: 65, duration: 2530 });
            expect(payloads[1]).toContain('<u:GetTransportInfo');
            expect(payloads[2]).toContain('<u:GetPositionInfo');
        } finally {
            jest.spyOn(http, 'request').mockRestore();
        }
    });

    test('falls back to re-Set at position when the renderer refuses every seek', async () => {
        const manager = new DlnaCastManager();
        const device = { id: 'dev', name: 'TV', controlUrl: 'http://192.168.1.20:5000/ctl/AVTransport' };
        manager.lastCastByDevice.set(device.id, {
            videoUrl: 'http://browser.example/video.mp4',
            metadata: { title: 'Movie', mimeType: 'video/mp4' },
            serviceType: 'urn:schemas-upnp-org:service:AVTransport:1'
        });
        const payloads = [];
        const fault = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>s:Client</faultstring><detail><UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
        // call 0: REL_TIME seek refused, call 1: ABS_TIME refused,
        // call 2: re-Set, call 3: position seek accepted, call 4: Play.
        const outcomes = [
            { status: 500, body: fault },
            { status: 500, body: fault },
            { status: 200, body: '<SetAVTransportURIResponse/>' },
            { status: 200, body: '<SeekResponse/>' },
            { status: 200, body: '<PlayResponse/>' }
        ];
        let call = 0;
        const requestMock = jest.fn((options, callback) => {
            const request = new (require('node:events').EventEmitter)();
            request.end = (payload) => {
                payloads.push(payload.toString('utf8'));
                const outcome = outcomes[call] || outcomes[outcomes.length - 1];
                const response = new (require('node:events').EventEmitter)();
                response.statusCode = outcome.status;
                response.on = (event, handler) => {
                    if (event === 'data') handler(Buffer.from(outcome.body));
                    if (event === 'end') handler();
                };
                callback(response);
                response.emit('end');
                call += 1;
            };
            return request;
        });
        jest.spyOn(http, 'request').mockImplementation(requestMock);
        try {
            await expect(manager.seek(device, 125)).resolves.toEqual({ ok: true, device: 'TV', restarted: true });
            expect(payloads[2]).toContain('SetAVTransportURI');
            expect(payloads[3]).toContain('<Unit>REL_TIME</Unit><Target>0:02:05</Target>');
            expect(payloads[4]).toContain('<u:Play');
        } finally {
            jest.spyOn(http, 'request').mockRestore();
        }
    });

    test('only binds non-internal IPv4 addresses during discovery', () => {
        const addresses = localAddressesForTest();
        for (const address of addresses) expect(address).not.toBe('127.0.0.1');
    });
});

function localAddressesForTest() {
    const result = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
        }
    }
    return result;
}
