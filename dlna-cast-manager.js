const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');

// TEMPORARY DIAGNOSTIC — same sink as the relay; remove once TV transport
// controls are verified.
const CAST_DEBUG_LOG = '/tmp/cast-relay-debug.log';
function castDebug(message) {
    try {
        fs.appendFileSync(CAST_DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never break casting.
    }
}

const SSDP_PORT = 1900;
const SSDP_MULTICAST = '239.255.255.250';
const SEARCH_TIMEOUT_MS = 3000;
const SOAP_TIMEOUT_MS = 5000;
const MAX_DEVICES = 24;
const MAX_BODY_BYTES = 512 * 1024;
const SEARCH_TARGETS = [
    'urn:schemas-upnp-org:device:MediaRenderer:1',
    // Samsung TVs and other otherwise-compatible renderers sometimes answer
    // only a broad search, even though their description advertises AVTransport.
    'ssdp:all'
];

const USER_AGENT = 'Entrim Browser/1.0 DLNA';

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function localAddresses() {
    const result = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
        }
    }
    return result.length ? result : ['0.0.0.0'];
}

function discoveryLocation(buffer) {
    const headers = {};
    for (const line of buffer.toString('utf8').split('\r\n').slice(1)) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).trim().toUpperCase()] = line.slice(index + 1).trim();
    }

    try {
        const location = new URL(headers.LOCATION || '');
        // Device descriptions are fetched with node:http. DLNA renderers use
        // HTTP here; refusing other schemes also avoids following malformed
        // SSDP advertisements.
        return location.protocol === 'http:' ? location.toString() : '';
    } catch {
        return '';
    }
}

function httpGetText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const request = http.get(url, { headers: { 'USER-AGENT': USER_AGENT }, timeout: timeoutMs }, (response) => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    response.destroy();
                    return finish(reject, new Error('Device description too large.'));
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return httpGetText(response.headers.location, timeoutMs).then(
                        (text) => finish(resolve, text),
                        (error) => finish(reject, error)
                    );
                }
                if (response.statusCode !== 200) return finish(reject, new Error(`Device description HTTP ${response.statusCode}.`));
                finish(resolve, Buffer.concat(chunks).toString('utf8'));
            });
            response.on('error', (error) => finish(reject, error));
        });
        const timer = setTimeout(() => {
            request.destroy();
            finish(reject, new Error('Device description request timed out.'));
        }, timeoutMs);
        request.on('error', (error) => finish(reject, error));
        request.on('timeout', () => {
            request.destroy();
            finish(reject, new Error('Device description request timed out.'));
        });
    });
}

function tagContent(xml, tag) {
    const match = xml.match(new RegExp(`<[^>]*?${tag}[^>]*>([\\s\\S]*?)</[^>]*?${tag}\\s*>`, 'i'));
    return match ? match[1].trim().replace(/<!\[CDATA\[|\]\]>/g, '') : '';
}

// Parses "H:MM:SS[.mmm]" timecodes from AVTransport state variables.
function parseTimecode(value) {
    const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = match[4] ? Number(match[4].padEnd(3, '0')) : 0;
    if ([hours, minutes, seconds, millis].some((part) => !Number.isFinite(part))) return null;
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseDescription(xml, baseUrl) {
    const friendlyName = tagContent(xml, 'friendlyName');
    const controlUrl = (() => {
        const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
        for (const block of serviceBlocks) {
            const serviceType = tagContent(block, 'serviceType');
            if (!/AVTransport/i.test(serviceType)) continue;
            const control = tagContent(block, 'controlURL');
            if (!control) continue;
            try {
                return new URL(control, baseUrl).toString();
            } catch {
                return '';
            }
        }
        return '';
    })();
    return { friendlyName: friendlyName || 'Unknown device', controlUrl };
}

function postSoap(controlUrl, action, serviceType, body) {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">${body}</u:${action}></s:Body>
</s:Envelope>`;
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(controlUrl);
        } catch (error) {
            return reject(new Error('Invalid device control URL.'));
        }
        const payload = Buffer.from(envelope, 'utf8');
        const request = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers: {
                'CONTENT-TYPE': `text/xml; charset="utf-8"`,
                SOAPACTION: `"${serviceType}#${action}"`,
                'CONTENT-LENGTH': payload.length,
                'USER-AGENT': USER_AGENT
            },
            timeout: SOAP_TIMEOUT_MS
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) return response.destroy();
                chunks.push(chunk);
            });
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                castDebug(`soap ${action} → ${response.statusCode}`);
                if (response.statusCode >= 200 && response.statusCode < 300) return resolve(text);
                const errorDescription = tagContent(text, 'errorDescription');
                const faultString = tagContent(text, 'faultstring');
                const errorCode = tagContent(text, 'errorCode');
                const description = errorDescription || faultString || `HTTP ${response.statusCode}`;
                const detail = errorCode ? ` (UPnP ${errorCode})` : '';
                castDebug(`soap ${action} FAILED: ${description}${detail}`);
                reject(new Error(`Cast ${action} failed: ${description}${detail}`));
            });
            response.on('error', (error) => {
                castDebug(`soap ${action} ERROR: ${String(error?.message || error).slice(0, 120)}`);
                reject(error);
            });
        });
        request.on('timeout', () => {
            castDebug(`soap ${action} TIMEOUT`);
            request.destroy(new Error(`Cast ${action} timed out.`));
        });
        request.on('error', (error) => {
            castDebug(`soap ${action} ERROR: ${String(error?.message || error).slice(0, 120)}`);
            reject(error);
        });
        request.end(payload);
    });
}

class DlnaCastManager {
    constructor() {
        this.devices = [];
        this.activeDeviceKey = '';
        // Remembers the last SetAVTransportURI per device so seek can fall
        // back to "re-Set at position + Play" for renderers that refuse
        // mid-playback seeks.
        this.lastCastByDevice = new Map();
    }

    async discoverDevices(timeoutMs = SEARCH_TIMEOUT_MS) {
        const devices = new Map();
        const descriptionUrls = new Set();
        const sockets = [];

        const handleSearchResponse = (buffer, remoteInfo) => {
            const location = discoveryLocation(buffer);
            if (location && !descriptionUrls.has(location) && descriptionUrls.size < MAX_DEVICES) {
                descriptionUrls.add(location);
            }
        };

        for (const address of localAddresses()) {
            try {
                // SSDP requests must originate from source port 1900: some
                // renderers (AirScreen on Fire TV, other Android stacks) ignore
                // M-SEARCH sent from an ephemeral port and never answer.
                const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                sockets.push(socket);
                socket.on('message', handleSearchResponse);
                socket.on('error', () => {});
                await new Promise((resolve) => socket.bind({ address, port: SSDP_PORT }, resolve));
                for (const target of SEARCH_TARGETS) {
                    const search = Buffer.from(
                        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_MULTICAST}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\nUSER-AGENT: ${USER_AGENT}\r\n\r\n`
                    );
                    socket.send(search, 0, search.length, SSDP_PORT, SSDP_MULTICAST);
                }
            } catch {
                // Skip an address we cannot bind to.
            }
        }

        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        for (const socket of sockets) {
            try {
                socket.close();
            } catch {
                // Already closed.
            }
        }

        await Promise.all([...descriptionUrls].map(async (location) => {
            try {
                const xml = await httpGetText(location, SEARCH_TIMEOUT_MS);
                const { friendlyName, controlUrl } = parseDescription(xml, location);
                if (!controlUrl) return;
                devices.set(controlUrl, {
                    id: controlUrl,
                    name: friendlyName,
                    controlUrl,
                    host: new URL(controlUrl).hostname,
                    lastSeen: Date.now()
                });
            } catch {
                // Skip devices that fail to describe themselves.
            }
        }));

        this.devices = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
        return this.devices;
    }

    // UPnP duration format H:MM:SS; renderers gate REL_TIME seek on the
    // declared res duration.
    formatDuration(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const pad = (value) => String(value).padStart(2, '0');
        return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
    }

    async setVideo(device, videoUrl, metadata = {}) {
        if (!device || !device.controlUrl) throw new Error('Choose a discovered cast device first.');
        if (!/^https?:\/\//i.test(String(videoUrl || ''))) throw new Error('Cast needs a direct http(s) video URL.');

        const title = escapeXml(metadata.title || 'Video from Entrim Browser');
        const mime = escapeXml(metadata.mimeType || 'video/mp4');
        const serviceType = metadata.serviceType || 'urn:schemas-upnp-org:service:AVTransport:1';
        const protocolInfo = escapeXml(metadata.protocolInfo || `http-get:*:${mime}:*`);
        const uri = escapeXml(videoUrl);
        // Sidecar captions only reach Samsung renderers through DIDL metadata;
        // the pv/sec caption extensions point the TV at an SRT it can fetch.
        const subtitleUrl = /^https?:\/\//i.test(String(metadata.subtitleUrl || '')) ? String(metadata.subtitleUrl) : '';
        const resDuration = Number.isFinite(Number(metadata.duration)) && Number(metadata.duration) > 0
            ? ` duration="${this.formatDuration(metadata.duration)}"`
            : '';
        // The DIDL must always carry the <res> protocolInfo (DLNA.ORG_OP /
        // ORG_FLAGS): without it the renderer classifies the item as a live
        // broadcast and refuses pause/seek (UPnP 701). The title and upnp:class
        // stay too — without them renderers like AirScreen display the item as
        // "Unknown". Subtitle resources/extensions are attached when present.
        const currentUriMetadata = [
            '&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:pv="http://www.pv.com/ns/" xmlns:sec="http://www.sec.co.kr/"&gt;',
            '&lt;item id="0" parentID="0" restricted="1"&gt;',
            `&lt;dc:title&gt;${title}&lt;/dc:title&gt;`,
            '&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;',
                `&lt;res protocolInfo="${protocolInfo}"${resDuration}&gt;${uri}&lt;/res&gt;`,
                subtitleUrl ? `&lt;res protocolInfo="http-get:*:application/x-subrip:*"&gt;${escapeXml(subtitleUrl)}&lt;/res&gt;` : '',
                subtitleUrl ? `&lt;pv:captionInfo sec:type="srt"&gt;${escapeXml(subtitleUrl)}&lt;/pv:captionInfo&gt;` : '',
            subtitleUrl ? `&lt;sec:CaptionInfo sec:type="srt"&gt;${escapeXml(subtitleUrl)}&lt;/sec:CaptionInfo&gt;` : '',
            '&lt;/item&gt;&lt;/DIDL-Lite&gt;'
        ].filter(Boolean).join('');

        await postSoap(
            device.controlUrl,
            'SetAVTransportURI',
            serviceType,
            `<InstanceID>0</InstanceID>
<CurrentURI>${uri}</CurrentURI>
<CurrentURIMetaData>${currentUriMetadata}</CurrentURIMetaData>`
        );
        this.lastCastByDevice.set(device.id, { videoUrl, metadata: { ...metadata }, serviceType });
        // Some renderers refuse Seek while PLAYING but accept it right after a
        // Set (before Play), so a restart-style seek positions the transport
        // here and Play below simply continues from that point.
        const startAt = Math.max(0, Math.floor(Number(metadata.startAt) || 0));
        let positioned = startAt === 0;
        if (startAt > 0) {
            const target = this.formatDuration(startAt);
            for (const unit of ['REL_TIME', 'ABS_TIME']) {
                try {
                    await postSoap(
                        device.controlUrl,
                        'Seek',
                        serviceType,
                        `<InstanceID>0</InstanceID><Unit>${unit}</Unit><Target>${target}</Target>`
                    );
                    positioned = true;
                    break;
                } catch (error) {
                    castDebug(`start-at seek (${unit}) refused: ${String(error?.message || error).slice(0, 120)}`);
                }
            }
        }
        this.activeDeviceKey = device.id;
        return { ok: true, device: device.name, positioned };
    }

    async play(device) {
        if (!device || !device.controlUrl) throw new Error('No cast device selected.');
        await postSoap(device.controlUrl, 'Play', 'urn:schemas-upnp-org:service:AVTransport:1', '<InstanceID>0</InstanceID><Speed>1</Speed>');
        this.activeDeviceKey = device.id;
        return { ok: true, device: device.name };
    }

    async pause(device) {
        if (!device || !device.controlUrl) throw new Error('No cast device selected.');
        await postSoap(device.controlUrl, 'Pause', 'urn:schemas-upnp-org:service:AVTransport:1', '<InstanceID>0</InstanceID>');
        return { ok: true, device: device.name };
    }

    // AVTransport REL_TIME seek; seconds are formatted as H:MM:SS. Some
    // renderers only accept ABS_TIME, and others refuse seeks entirely while
    // playing but accept them right after a Set — so the final fallback
    // re-Sets the same media positioned at the target and Plays again.
    async seek(device, seconds) {
        if (!device || !device.controlUrl) throw new Error('No cast device selected.');
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const pad = (value) => String(value).padStart(2, '0');
        const target = `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
        const attempt = async (unit) => postSoap(
            device.controlUrl,
            'Seek',
            'urn:schemas-upnp-org:service:AVTransport:1',
            `<InstanceID>0</InstanceID><Unit>${unit}</Unit><Target>${target}</Target>`
        );
        try {
            await attempt('REL_TIME');
            return { ok: true, device: device.name };
        } catch (error) {
            if (!/701|710|transition/i.test(String(error?.message || ''))) throw error;
            try {
                await attempt('ABS_TIME');
                return { ok: true, device: device.name };
            } catch (absError) {
                if (!/701|710|transition/i.test(String(absError?.message || ''))) throw absError;
                const last = this.lastCastByDevice.get(device.id);
                if (!last?.videoUrl) throw absError;
                castDebug('seek: renderer refuses mid-playback seek, restarting at position');
                const reset = await this.setVideo(device, last.videoUrl, { ...last.metadata, startAt: total });
                if (!reset.positioned) throw absError;
                await this.play(device);
                return { ok: true, device: device.name, restarted: true };
            }
        }
    }

    // Polls the renderer for transport state and playback position so the
    // browser panel can show progress and drive controls from the web page.
    async getStatus(device) {
        if (!device || !device.controlUrl) throw new Error('No cast device selected.');
        const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1';
        const [transportXml, positionXml] = await Promise.all([
            postSoap(device.controlUrl, 'GetTransportInfo', serviceType, '<InstanceID>0</InstanceID>'),
            postSoap(device.controlUrl, 'GetPositionInfo', serviceType, '<InstanceID>0</InstanceID>')
        ]);
        const state = (tagContent(transportXml, 'CurrentTransportState') || '').toUpperCase();
        const position = parseTimecode(tagContent(positionXml, 'RelTime')) ?? parseTimecode(tagContent(positionXml, 'AbsTime'));
        const duration = parseTimecode(tagContent(positionXml, 'TrackDuration'));
        return {
            state: state || 'UNKNOWN',
            position: Number.isFinite(position) ? position : null,
            duration: Number.isFinite(duration) ? duration : null
        };
    }

    async castVideo(device, videoUrl, metadata = {}) {
        const serviceType = metadata.serviceType || 'urn:schemas-upnp-org:service:AVTransport:1';
        if (!device || !device.controlUrl) throw new Error('Choose a discovered cast device first.');
        const resetRenderer = async () => {
            try {
                // Renderers reject a new SetAVTransportURI while a transition
                // is pending (UPnP 701); a best-effort Stop resets the state.
                await postSoap(device.controlUrl, 'Stop', serviceType, '<InstanceID>0</InstanceID>');
            } catch {
                // Stopping an idle renderer may fail; the Set still decides.
            }
        };
        await resetRenderer();
        try {
            await this.setVideo(device, videoUrl, metadata);
            return await this.play(device);
        } catch (error) {
            if (!/701|transition/i.test(String(error?.message || ''))) throw error;
            // Some models need a beat between Stop and a fresh transition.
            await new Promise((resolve) => setTimeout(resolve, 800));
            await resetRenderer();
            await this.setVideo(device, videoUrl, metadata);
            return this.play(device);
        }
    }

    async stop(device) {
        if (!device || !device.controlUrl) throw new Error('No cast device selected.');
        try {
            await postSoap(
                device.controlUrl,
                'Stop',
                'urn:schemas-upnp-org:service:AVTransport:1',
                '<InstanceID>0</InstanceID>'
            );
        } finally {
            if (this.activeDeviceKey === device.id) this.activeDeviceKey = '';
            this.lastCastByDevice.delete(device.id);
        }
        return { ok: true };
    }
}

module.exports = DlnaCastManager;
module.exports.parseDescription = parseDescription;
module.exports.tagContent = tagContent;
module.exports.parseTimecode = parseTimecode;
module.exports.postSoap = postSoap;
module.exports.discoveryLocation = discoveryLocation;
